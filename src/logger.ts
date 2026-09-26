import pino, { type Logger } from 'pino';

let root: Logger | undefined;

export function initLogger(level: string, pretty: boolean): Logger {
  root = pino({
    level,
    base: undefined,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
  return root;
}

export function logger(): Logger {
  if (!root) throw new Error('logger no inicializado: llama a initLogger() primero');
  return root;
}

/** Logger hijo con la clave del ticket en cada línea. */
export function ticketLogger(ticket: string, extra: Record<string, unknown> = {}): Logger {
  return logger().child({ ticket, ...extra });
}
