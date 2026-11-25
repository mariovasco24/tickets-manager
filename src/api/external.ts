import { timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Intake } from '../intake.js';
import type { JobService } from '../jobs/service.js';
import { logger, ticketLogger } from '../logger.js';
import { STATUS_LABELS, alreadyFixedLabel, isAwaiting, isTerminal, type JobDto } from '../shared/job-types.js';

/**
 * API para agentes externos (contrato v1). Un agente de QA que decide que un bug lo debe resolver
 * este equipo pide el fix con la clave del ticket y el servicio arranca el MISMO flujo que /fix en
 * Slack: hilo, estado en Jira, rama, repos… con todas las confirmaciones humanas de siempre.
 *
 * Vive fuera de /api a propósito: el túnel público puede exponer solo /external/* y dejar el
 * dashboard en privado. Cada agente tiene su propio token (EXTERNAL_API_TOKENS).
 */

const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

const fixRequestSchema = z
  .object({
    ticket: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(TICKET_RE, 'formato esperado: PROYECTO-123')),
    /** Persona en cuyo nombre pide el agente (se muestra en Slack). Por defecto, el nombre del token. */
    requested_by: z.string().trim().min(1).max(100).optional(),
    /** Por qué lo debe resolver desarrollo: análisis del agente, pasos, evidencia. Llega a Claude como notas del equipo. */
    reason: z.string().trim().max(4000).optional(),
    /** Rama origen, si se sabe (p. ej. dev/release.9.6). Si falta, se pregunta en Slack. */
    source_branch: z.string().trim().regex(BRANCH_RE, 'nombre de rama inválido').optional(),
  })
  .strict();


export function externalRouter(config: Config, jobs: JobService, intake: Intake): Router {
  const router = Router();
  const log = logger().child({ component: 'external-api' });
  const tokens = config.EXTERNAL_API_TOKENS.map((t) => ({ name: t.name, token: Buffer.from(t.token) }));
  const hits = new Map<string, number[]>();

  router.use(express.json({ limit: '32kb' }));

  router.use((req: Request, res: Response, next: NextFunction) => {
    const [scheme, value] = (req.header('authorization') ?? '').split(' ');
    const given = scheme === 'Bearer' && value ? Buffer.from(value) : undefined;
    const match = given && tokens.find((t) => t.token.length === given.length && timingSafeEqual(t.token, given));
    if (!match) {
      log.warn({ ip: req.ip, path: req.path }, 'Petición externa sin token válido');
      res.status(401).json(error('unauthorized', 'Falta o es inválida la cabecera Authorization: Bearer <token>'));
      return;
    }
    res.locals.caller = match.name;
    next();
  });

  /** Pedir el fix de un ticket. */
  router.post('/v1/fix-requests', async (req, res) => {
    const caller = { name: String(res.locals.caller) };
    const parsed = fixRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(error('invalid_request', 'El cuerpo no cumple el contrato', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)));
      return;
    }
    const body = parsed.data;
    const project = body.ticket.split('-')[0]!;
    if (config.EXTERNAL_ALLOWED_PROJECTS.length && !config.EXTERNAL_ALLOWED_PROJECTS.includes(project)) {
      res.status(422).json(error('project_not_allowed', `El proyecto ${project} no está habilitado para peticiones externas`));
      return;
    }
    if (!allow(hits, caller.name, config.EXTERNAL_RATE_LIMIT_PER_HOUR)) {
      res.setHeader('Retry-After', '3600');
      res.status(429).json(error('rate_limited', `Máximo ${config.EXTERNAL_RATE_LIMIT_PER_HOUR} peticiones por hora`));
      return;
    }

    const existing = jobs.findActiveByTicket(body.ticket);
    if (existing) {
      res.status(200).json({ created: false, ...view(existing, config) });
      return;
    }

    const tlog = ticketLogger(body.ticket, { source: 'external', caller: caller.name });
    tlog.info({ requestedBy: body.requested_by, sourceBranch: body.source_branch }, 'Petición de fix recibida por la API externa');
    try {
      const job = await intake.receive({
        key: body.ticket,
        source: 'external',
        requestedBy: body.requested_by ? `${body.requested_by} (vía ${caller.name})` : caller.name,
        sourceBranch: body.source_branch,
        notes: body.reason,
      });
      if (!job) {
        res.status(500).json(error('internal_error', 'No se pudo crear el job'));
        return;
      }
      if (job.status === 'failed') {
        res.status(422).json({ ...error('ticket_unreadable', job.failureReason ?? 'No se pudo leer el ticket en Jira'), ...view(job, config) });
        return;
      }
      if (job.status === 'discarded') {
        res.status(409).json({ ...error('ticket_closed', job.failureReason ?? 'El ticket está cerrado'), ...view(job, config) });
        return;
      }
      res.status(202).json({ created: true, ...view(job, config) });
    } catch (err) {
      tlog.error({ err }, 'Fallo procesando la petición externa');
      res.status(500).json(error('internal_error', (err as Error).message));
    }
  });

  /** Estado de una petición (para que el agente haga seguimiento). Solo jobs pedidos por la API externa. */
  router.get('/v1/fix-requests/:jobId', (req, res) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job || job.source !== 'external') {
      res.status(404).json(error('not_found', 'Petición no encontrada'));
      return;
    }
    res.json(view(job, config));
  });

  return router;
}

/** Vista pública y estable del job (contrato v1). No expone rutas locales, costes ni la sesión. */
function view(job: JobDto, config: Config) {
  const base = config.DASHBOARD_URL ?? config.PUBLIC_BASE_URL;
  return {
    job_id: job.id,
    ticket: job.ticketKey,
    ticket_url: job.ticketUrl,
    status: job.status,
    status_label: STATUS_LABELS[job.status],
    state: isTerminal(job.status) ? 'finished' : isAwaiting(job.status) ? 'waiting_for_human' : 'in_progress',
    pending_question: job.pendingQuestion,
    requested_by: job.requestedBy,
    source_branch: job.sourceBranch,
    slack_thread_url: job.slackPermalink,
    dashboard_url: base ? `${base}/?job=${job.id}` : null,
    result:
      job.status === 'fixed'
        ? {
            kind: job.alreadyFixed ? 'already_fixed' : 'fixed',
            already_fixed_by: job.alreadyFixed ? alreadyFixedLabel(job.alreadyFixed) || null : null,
            issue: job.issue,
            solution: job.solution,
            notes_for_qa: job.notesForQa,
            reproduction: job.reproduction,
          }
        : job.status === 'cannot_fix' || job.status === 'failed' || job.status === 'discarded'
          ? { kind: job.status, reason: job.failureReason }
          : null,
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: new Date(job.updatedAt).toISOString(),
    finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
  };
}

function error(code: string, message: string, details?: string[]) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

/** Ventana deslizante de una hora por agente (en memoria: basta para un servicio de un solo proceso). */
function allow(hits: Map<string, number[]>, who: string, limit: number): boolean {
  const now = Date.now();
  const recent = (hits.get(who) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= limit) {
    hits.set(who, recent);
    return false;
  }
  recent.push(now);
  hits.set(who, recent);
  return true;
}
