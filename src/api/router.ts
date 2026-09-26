import express, { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Intake } from '../intake.js';
import { JobStateError, type JobService } from '../jobs/service.js';
import { JOB_STATUSES, type MetaDto } from '../shared/job-types.js';
import type { SseHub } from './sse.js';

const answerSchema = z.object({ answer: z.string().trim().min(1).max(4000) });
const discardSchema = z.object({ reason: z.string().trim().max(500).optional() });
const listSchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});
const reposSchema = z.object({
  action: z.enum(['confirm', 'reject']).default('confirm'),
  repos: z.array(z.string().trim().min(1)).min(1).optional(),
});
const jiraSchema = z.object({ action: z.enum(['transition', 'skip']).default('transition') });
const jiraCommentSchema = z.object({ action: z.enum(['publish', 'skip']).default('publish') });
const pullRequestSchema = z.object({ action: z.enum(['open', 'skip']).default('open') });
const regressionSchema = z.object({ action: z.enum(['accept', 'discard']).default('accept') });
const jiraMergeSchema = z.object({ action: z.enum(['transition', 'skip']).default('transition') });
const envSchema = z.object({ action: z.enum(['code_only', 'discard', 'retry']).default('code_only') });
const devStatusSchema = z.object({
  status: z.enum(JOB_STATUSES),
  question: z.string().trim().max(2000).optional(),
});

/** API JSON del dashboard. Se monta bajo /api con su propio body parser. */
export function apiRouter(config: Config, jobs: JobService, intake: Intake, sse: SseHub): Router {
  const router = Router();
  router.use(express.json({ limit: '256kb' }));

  router.get('/meta', (_req, res) => {
    const meta: MetaDto = {
      statuses: JOB_STATUSES,
      devMode: config.NODE_ENV === 'development',
      prEnabled: config.PR_ENABLED,
      jiraMergeStatus: config.JIRA_ALLOW_TRANSITION ? (config.JIRA_WAITING_FOR_MERGE_STATUS ?? null) : null,
    };
    res.json(meta);
  });

  router.get('/jobs', (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'filtros inválidos', issues: parsed.error.issues });
      return;
    }
    res.json(jobs.list(parsed.data));
  });

  router.get('/jobs/:id', (req, res) => {
    const detail = jobs.getDetail(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: 'job no encontrado' });
      return;
    }
    res.json(detail);
  });

  /** Transcripción de la sesión de Claude Code. `?after=<id>` para paginar incrementalmente. */
  router.get('/jobs/:id/messages', (req, res) => {
    const id = String(req.params.id);
    if (!jobs.get(id)) {
      res.status(404).json({ error: 'job no encontrado' });
      return;
    }
    const after = Number(req.query.after ?? 0);
    res.json(jobs.listMessages(id, Number.isFinite(after) ? after : 0));
  });

  router.post('/jobs/:id/answer', async (req, res) => {
    const body = answerSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'respuesta inválida' });
      return;
    }
    try {
      const job = await intake.answer(String(req.params.id), body.data.answer, 'dashboard', 'dashboard');
      res.json(job);
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Confirmar (con lista opcional) o rechazar los repositorios propuestos para un job en awaiting_repos. */
  router.post('/jobs/:id/repos', async (req, res) => {
    const body = reposSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'cuerpo inválido', issues: body.error.issues });
      return;
    }
    try {
      const id = String(req.params.id);
      const job =
        body.data.action === 'reject'
          ? await intake.rejectRepos(id, 'dashboard', 'dashboard')
          : await intake.confirmRepos(id, body.data.repos, 'dashboard', 'dashboard');
      res.json(job);
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Evidencia de la reproducción (metadatos; el binario va por la ruta de abajo). */
  router.get('/jobs/:id/artifacts', (req, res) => {
    const id = String(req.params.id);
    if (!jobs.get(id)) {
      res.status(404).json({ error: 'job no encontrado' });
      return;
    }
    res.json(jobs.listArtifacts(id));
  });

  router.get('/jobs/:id/artifacts/:artifactId', (req, res) => {
    const file = jobs.artifactPath(String(req.params.id), Number(req.params.artifactId));
    if (!file) {
      res.status(404).json({ error: 'artefacto no encontrado' });
      return;
    }
    // dotfiles: por defecto Express devuelve 404 si la ruta cruza un directorio oculto.
    res.sendFile(file, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'el archivo ya no está en disco' });
    });
  });

  /** Estado en Jira: mover a "en curso" o dejarlo igual. */
  router.post('/jobs/:id/jira', async (req, res) => {
    const body = jiraSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'cuerpo inválido' });
      return;
    }
    try {
      res.json(await intake.jiraDecision(String(req.params.id), body.data.action === 'transition', 'dashboard', 'dashboard'));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Fix sin spec de regresión: aceptar sin spec o descartar. */
  router.post('/jobs/:id/regression', async (req, res) => {
    const body = regressionSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'cuerpo inválido' });
      return;
    }
    try {
      res.json(await intake.regressionDecision(String(req.params.id), body.data.action === 'accept', 'dashboard', 'dashboard'));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Subir la rama y abrir el PR hacia la rama origen (o no). Nunca push directo ni merge. */
  router.post('/jobs/:id/pull-request', async (req, res) => {
    const body = pullRequestSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'cuerpo inválido' });
      return;
    }
    try {
      res.json(await intake.pullRequestDecision(String(req.params.id), body.data.action === 'open', 'dashboard', 'dashboard'));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Tras el PR: mover el ticket al estado de espera de merge, o dejarlo. */
  router.post('/jobs/:id/jira-merge', async (req, res) => {
    const body = jiraMergeSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'cuerpo inválido' });
      return;
    }
    try {
      res.json(await intake.jiraMergeDecision(String(req.params.id), body.data.action === 'transition', 'dashboard', 'dashboard'));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Publicar el reporte del fix como comentario en el ticket. */
  router.post('/jobs/:id/jira-comment', async (req, res) => {
    const body = jiraCommentSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'cuerpo inválido' });
      return;
    }
    try {
      res.json(await intake.publishJiraComment(String(req.params.id), body.data.action === 'publish', 'dashboard', 'dashboard'));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Sin entorno de reproducción: continuar solo con código o descartar. */
  router.post('/jobs/:id/env', async (req, res) => {
    const body = envSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'cuerpo inválido' });
      return;
    }
    try {
      const id = String(req.params.id);
      const job =
        body.data.action === 'discard'
          ? await intake.discard(id, 'sin entorno de reproducción', 'dashboard')
          : body.data.action === 'retry'
            ? await intake.retryEnvironment(id, 'dashboard', 'dashboard')
            : await intake.continueWithoutEnv(id, 'dashboard', 'dashboard');
      res.json(job);
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Repositorios del manifest con su estado de clonado (para el dashboard). */
  router.get('/repos', (_req, res) => {
    res.json(intake.listRepos());
  });

  /** Mensaje libre para la sesión (como escribir en el hilo): encola, responde o reabre según el estado. */
  router.post('/jobs/:id/message', async (req, res) => {
    const body = answerSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'mensaje inválido' });
      return;
    }
    try {
      res.json(await intake.humanMessage(String(req.params.id), body.data.answer, 'dashboard', 'dashboard'));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/jobs/:id/discard', async (req, res) => {
    const body = discardSchema.safeParse(req.body ?? {});
    try {
      const job = await intake.discard(String(req.params.id), body.success ? body.data.reason : undefined, 'dashboard');
      res.json(job);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/branches', async (_req, res) => {
    try {
      res.json(await intake.listBranches());
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  router.delete('/jobs/:id/worktree', async (req, res) => {
    try {
      res.json(await intake.removeWorktree(String(req.params.id), 'dashboard'));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/worktrees/cleanup', async (_req, res) => {
    res.json(await intake.cleanupClosedWorktrees('dashboard'));
  });

  router.get('/events', sse.handler);

  // Solo en desarrollo: fuerza estados para ver el dashboard sin trabajo real detrás.
  if (config.NODE_ENV === 'development') {
    router.post('/dev/jobs/:id/status', (req, res) => {
      const body = devStatusSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: 'estado inválido', issues: body.error.issues });
        return;
      }
      try {
        const id = String(req.params.id);
        const { status, question } = body.data;
        const current = jobs.get(id);
        if (!current) {
          res.status(404).json({ error: 'job no encontrado' });
          return;
        }
        const job =
          status === 'awaiting_branch' || status === 'awaiting_clarification'
            ? jobs.ask(id, status, question ?? '¿Pregunta simulada desde /api/dev?')
            : jobs.transition(id, status, `Estado forzado desde /api/dev: ${status}`, simulatedPatch(status, current));
        res.json(job);
      } catch (err) {
        handleError(err, res);
      }
    });
  }

  return router;
}

/** Datos de relleno para el dashboard. Nunca pisa rama/worktree reales del job. */
function simulatedPatch(status: string, current: { branch: string | null; worktreePath: string | null }) {
  if (status === 'fixed') {
    return {
      branch: current.branch ?? 'fix/SIMULADO',
      worktreePath: current.worktreePath ?? '/tmp/worktrees/SIMULADO',
      filesChanged: ['src/ejemplo.ts', 'src/ejemplo.test.ts'],
      testsResult: 'passed' as const,
      fixSummary: 'Resumen simulado del arreglo para probar el dashboard.',
    };
  }
  if (status === 'cannot_fix' || status === 'failed') {
    return { failureReason: `Motivo simulado (${status})` };
  }
  return {};
}

function handleError(err: unknown, res: express.Response): void {
  if (err instanceof JobStateError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof Error && /no existe/.test(err.message)) {
    res.status(404).json({ error: err.message });
    return;
  }
  throw err;
}
