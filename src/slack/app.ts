import { App, ExpressReceiver, LogLevel } from '@slack/bolt';
import type { Express } from 'express';
import type { Config } from '../config.js';
import { logger } from '../logger.js';

export interface SlackRuntime {
  app: App;
  /** true si Bolt vive en un websocket (Socket Mode); false si está montado en Express. */
  socketMode: boolean;
}

/**
 * Crea la app de Bolt en uno de dos modos, según SLACK_SOCKET_MODE:
 *  - Socket Mode: sin URL pública; Slack autentica el websocket con el app token.
 *  - HTTP: monta POST /slack/events en NUESTRA instancia de Express, con la
 *    verificación de firma de Slack que hace el propio ExpressReceiver.
 */
export function createSlackApp(config: Config, expressApp: Express): SlackRuntime {
  const log = logger().child({ component: 'slack' });
  const logLevel = config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace' ? LogLevel.DEBUG : LogLevel.WARN;

  if (config.SLACK_SOCKET_MODE) {
    const app = new App({
      token: config.SLACK_BOT_TOKEN,
      appToken: config.SLACK_APP_TOKEN,
      socketMode: true,
      logLevel,
      deferInitialization: true, // init() explícito en index.ts para capturar errores de token
    });
    registerErrorHandler(app);
    log.info('Slack en Socket Mode');
    return { app, socketMode: true };
  }

  const receiver = new ExpressReceiver({
    signingSecret: config.SLACK_SIGNING_SECRET,
    endpoints: '/slack/events',
    app: expressApp,
    logLevel,
  });
  const app = new App({ token: config.SLACK_BOT_TOKEN, receiver, logLevel, deferInitialization: true });
  registerErrorHandler(app);
  log.info('Slack en modo HTTP: POST /slack/events con firma verificada');
  return { app, socketMode: false };
}

function registerErrorHandler(app: App): void {
  app.error(async (error) => {
    logger().error({ err: error, component: 'slack' }, 'Error no manejado en Bolt');
  });
}
