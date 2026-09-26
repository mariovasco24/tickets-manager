import type { Request, Response } from 'express';
import { logger } from '../logger.js';

/**
 * Hub de Server-Sent Events para el dashboard. Cada cambio de job se emite a
 * todos los clientes conectados; un heartbeat cada 25 s mantiene vivas las
 * conexiones a través de proxies.
 */
export class SseHub {
  private readonly clients = new Set<Response>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  handler = (req: Request, res: Response): void => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: no bufferizar
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ clients: this.clients.size + 1 })}\n\n`);

    this.clients.add(res);
    logger().debug({ clients: this.clients.size }, 'Cliente SSE conectado');

    req.on('close', () => {
      this.clients.delete(res);
      logger().debug({ clients: this.clients.size }, 'Cliente SSE desconectado');
    });
  };

  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
