import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import type { Config } from '../config.js';
import type { Intake } from '../intake.js';
import { logger, ticketLogger } from '../logger.js';

/**
 * Verifica la firma HMAC-SHA256 que Jira Cloud envía en `X-Hub-Signature`
 * cuando el webhook se registra con un "secret": `sha256=<hex>`.
 */
export function verifyJiraSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const [algo, provided] = header.split('=');
  if (algo !== 'sha256' || !provided) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface JiraWebhookPayload {
  webhookEvent?: string;
  issue?: {
    key?: string;
    fields?: {
      summary?: string;
      issuetype?: { name?: string };
      project?: { key?: string };
    };
  };
  user?: { displayName?: string };
}

export function jiraWebhookRouter(config: Config, secret: string, intake: Intake): Router {
  const router = Router();
  const log = logger().child({ component: 'jira-webhook' });

  // Raw body imprescindible para validar la firma: nunca montar express.json() antes de esta ruta.
  router.post('/webhooks/jira', express.raw({ type: '*/*', limit: '5mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!verifyJiraSignature(raw, req.header('x-hub-signature'), secret)) {
      log.warn({ ip: req.ip, hasHeader: Boolean(req.header('x-hub-signature')) }, 'Webhook de Jira con firma inválida, rechazado');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: JiraWebhookPayload;
    try {
      payload = JSON.parse(raw.toString('utf8')) as JiraWebhookPayload;
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }

    const event = payload.webhookEvent;
    const key = payload.issue?.key;
    const issueType = payload.issue?.fields?.issuetype?.name;

    if (event !== 'jira:issue_created' || !key) {
      log.debug({ event, key }, 'Evento ignorado (no es issue_created)');
      res.status(200).json({ ignored: true, reason: 'event' });
      return;
    }
    // Sin filtro por proyecto: el servicio atiende cualquier proyecto de Jira; el tipo de issue sí se filtra.
    if (!issueType || !config.JIRA_BUG_ISSUE_TYPES.some((t) => t.toLowerCase() === issueType.toLowerCase())) {
      log.debug({ key, issueType }, 'Evento ignorado (no es Bug)');
      res.status(200).json({ ignored: true, reason: 'issuetype' });
      return;
    }

    // Respondemos rápido (Jira reintenta si tardamos) y procesamos en segundo plano.
    res.status(202).json({ accepted: true, key });

    const tlog = ticketLogger(key, { source: 'webhook' });
    tlog.info({ issueType, summary: payload.issue?.fields?.summary }, 'Bug creado en Jira recibido por webhook');
    intake
      .receive({ key, source: 'webhook', requestedBy: payload.user?.displayName ?? 'Jira' })
      .catch((err: unknown) => tlog.error({ err }, 'Fallo procesando el webhook'));
  });

  return router;
}
