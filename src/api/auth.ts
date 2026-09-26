import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface AuthOptions {
  user?: string;
  password?: string;
  /** Token de dispositivo (VOICE_TOKEN): se acepta como `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Exigir credenciales aunque solo haya token (rutas de DABOT). Sin esto, sin auth básica la ruta queda abierta. */
  requireToken?: boolean;
}

/**
 * Auth del dashboard y su API. Auth básica para el navegador y, si hay token de
 * dispositivo, Bearer para la tablet de DABOT. Sin nada configurado queda
 * abierta (local). Nunca se aplica a /slack/events ni /webhooks/jira, que
 * tienen su propia verificación de firma.
 */
export function basicAuth({ user, password, bearerToken, requireToken = false }: AuthOptions): RequestHandler {
  const basic = user && password ? Buffer.from(`${user}:${password}`) : undefined;
  const bearer = bearerToken ? Buffer.from(bearerToken) : undefined;
  if (!basic && !(bearer && requireToken)) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const [scheme, encoded] = (req.header('authorization') ?? '').split(' ');
    const ok =
      (basic && scheme === 'Basic' && encoded && safeEqual(Buffer.from(encoded, 'base64'), basic)) ||
      (bearer && scheme === 'Bearer' && encoded && safeEqual(Buffer.from(encoded), bearer));
    if (ok) {
      next();
      return;
    }
    if (basic) res.setHeader('WWW-Authenticate', 'Basic realm="Bugs Manager", charset="UTF-8"');
    res.status(401).send('Autenticación requerida');
  };
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
