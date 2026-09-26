import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Auth básica para el dashboard y su API. Se activa solo si hay usuario y
 * contraseña configurados (VPS); en local queda desactivada. Nunca se aplica a
 * /slack/events ni /webhooks/jira, que tienen su propia verificación de firma.
 */
export function basicAuth(user: string | undefined, password: string | undefined): RequestHandler {
  if (!user || !password) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const expected = Buffer.from(`${user}:${password}`);

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const provided = Buffer.from(encoded, 'base64');
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Bugs Manager", charset="UTF-8"');
    res.status(401).send('Autenticación requerida');
  };
}
