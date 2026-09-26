import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { basicAuth } from './api/auth.js';
import { apiRouter } from './api/router.js';
import type { SseHub } from './api/sse.js';
import type { Config } from './config.js';
import type { Intake } from './intake.js';
import { jiraWebhookRouter } from './jira/webhook.js';
import type { JobService } from './jobs/service.js';
import { logger } from './logger.js';
import { projectRoot } from './util/project-root.js';

export interface HttpDeps {
  config: Config;
  intake: Intake;
  jobs: JobService;
  sse: SseHub;
}

/**
 * Monta las rutas HTTP. No hay `express.json()` global: el webhook de Jira y el
 * receiver de Slack necesitan el cuerpo crudo para validar firmas; la API del
 * dashboard lleva su propio parser bajo /api.
 */
export function mountHttp(app: Express, { config, intake, jobs, sse }: HttpDeps): void {
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      slackMode: config.SLACK_SOCKET_MODE ? 'socket' : 'http',
      jiraWebhook: Boolean(config.JIRA_WEBHOOK_SECRET),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  if (config.JIRA_WEBHOOK_SECRET) {
    app.use(jiraWebhookRouter(config, config.JIRA_WEBHOOK_SECRET, intake));
    logger().info('Webhook de Jira activo en POST /webhooks/jira');
  } else {
    logger().info('Webhook de Jira desactivado (sin JIRA_WEBHOOK_SECRET). Disparo solo manual desde Slack.');
  }

  // Dashboard + API: auth básica solo si está configurada (VPS).
  const auth = basicAuth(config.DASHBOARD_BASIC_AUTH_USER, config.DASHBOARD_BASIC_AUTH_PASSWORD);
  if (config.DASHBOARD_BASIC_AUTH_USER) logger().info('Dashboard protegido con auth básica');

  app.use('/api', auth, apiRouter(config, jobs, intake, sse));

  const webDist = path.join(projectRoot(), 'dist', 'web');
  const indexHtml = path.join(webDist, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(auth, express.static(webDist, { index: false, maxAge: '1h' }));
    // SPA fallback: cualquier ruta que no sea API/Slack/webhook devuelve el index.
    app.get(/^\/(?!api\/|slack\/|webhooks\/|health$).*/, auth, (_req, res) => {
      res.sendFile(indexHtml);
    });
    logger().info({ webDist }, 'Dashboard servido desde dist/web');
  } else {
    app.get('/', auth, (_req, res) => {
      res
        .type('text/plain')
        .send(
          'Dashboard no compilado. En desarrollo usa `pnpm dev:web` (http://localhost:5173) o compílalo con `pnpm build:web`.',
        );
    });
    logger().warn('dist/web no existe: el dashboard no se sirve desde este puerto (usa pnpm dev:web)');
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger().error({ err }, 'Error HTTP no manejado');
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });
}
