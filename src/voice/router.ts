import express, { Router } from 'express';
import { z } from 'zod';
import type { SseHub } from '../api/sse.js';
import type { VoiceService } from './service.js';

const commandSchema = z.object({
  text: z.string().trim().max(2000),
  /** Job que muestra la tablet: a él se refieren "sí", "no" o "la dos". */
  jobId: z.string().trim().min(1).optional(),
});
const decideSchema = z.object({ option: z.string().trim().min(1).max(300) });

/** API de DABOT (tablet Android). Se monta bajo /api/voice. */
export function voiceRouter(voice: VoiceService, hub: SseHub): Router {
  const router = Router();
  router.use(express.json({ limit: '32kb' }));

  router.get('/state', async (_req, res) => {
    res.json(await voice.state());
  });

  /** Frase transcrita en la tablet. Los anuncios que provoque salen por SSE después de esta respuesta. */
  router.post('/command', async (req, res) => {
    const body = commandSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'comando inválido' });
      return;
    }
    const release = voice.hold();
    res.on('finish', release);
    res.on('close', release);
    res.json(await voice.command(body.data.text, body.data.jobId));
  });

  /** Opción tocada en la pantalla. */
  router.post('/jobs/:id/decide', async (req, res) => {
    const body = decideSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'opción inválida' });
      return;
    }
    const release = voice.hold();
    res.on('finish', release);
    res.on('close', release);
    res.json(await voice.decide(String(req.params.id), body.data.option));
  });

  /** Buscador de ramas (como el desplegable de Slack): ?q=texto. */
  router.get('/branches', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    res.json(await voice.searchBranches(q));
  });

  router.get('/events', hub.handler);

  return router;
}
