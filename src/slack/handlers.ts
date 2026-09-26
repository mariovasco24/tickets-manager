import type { App, types } from '@slack/bolt';
import type { Config } from '../config.js';
import type { Intake } from '../intake.js';
import { logger, ticketLogger } from '../logger.js';

export interface ParsedRequest {
  key: string;
  sourceBranch?: string;
  /** Contexto adicional del equipo para el prompt (no viene del ticket). */
  notes?: string;
}

/**
 * Extrae "AN-1234", opcionalmente "desde <rama>" y notas adicionales de un texto libre.
 *
 *   /fix AN-1234
 *   /fix AN-1234 desde develop
 *   /fix AN-1234 ten en cuenta el componente X          → notas (freeNotes: todo lo que sobra)
 *   /fix AN-1234 desde develop: el bug está en Y        → rama + notas
 *   @bot revisa AN-1234: fíjate en el listener Z        → notas solo tras ":" o salto de línea
 *
 * En menciones (freeNotes=false) las notas requieren ":" o salto de línea, para no tomar
 * "revisa el ticket" como contexto.
 */
export function parseRequest(text: string, opts: { freeNotes: boolean } = { freeNotes: false }): ParsedRequest | undefined {
  // Cualquier clave de Jira (XYZ-123): el servicio no está atado a un proyecto.
  const keyRe = /\b([A-Za-z][A-Za-z0-9_]+-\d+)\b/;
  const keyMatch = keyRe.exec(text);
  if (!keyMatch?.[1]) return undefined;
  const key = keyMatch[1].toUpperCase();

  // Quitamos menciones <@U…>, la clave y "desde <rama>" para quedarnos con el resto.
  let rest = text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ').replace(keyRe, ' ');
  const branchRe = /\b(?:desde|from)\s+[`"']?([\w./-]+?)[`"']?(?=[\s:;,]|$)/i;
  const branchMatch = branchRe.exec(rest);
  const sourceBranch = branchMatch?.[1]?.replace(/[.,;:]+$/, '');
  if (branchMatch) rest = rest.replace(branchMatch[0], ' ');

  let notes: string | undefined;
  if (opts.freeNotes) {
    notes = rest;
  } else {
    const sep = rest.search(/[:\n]/);
    notes = sep >= 0 ? rest.slice(sep + 1) : undefined;
  }
  notes = notes
    ?.replace(/^[\s:;,.\-–—]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Restos de formato de Slack ("* *.", "``", etc.) no son notas: exige al menos una letra o número.
  if (!notes || !/[\p{L}\p{N}]/u.test(notes)) notes = undefined;

  return { key, ...(sourceBranch ? { sourceBranch } : {}), ...(notes ? { notes } : {}) };
}

export function registerSlackHandlers(app: App, config: Config, intake: Intake): void {
  const log = logger().child({ component: 'slack-handlers' });
  const usage = 'Dime qué ticket quieres revisar (vale cualquier proyecto de Jira), por ejemplo: `/fix AN-1234`, `/fix AN-1234 desde develop` o `/fix AN-1234 desde develop: el bug está en datasetswidget`.';

  // B) Manual por mención: "@bot revisa el ticket AN-1234"
  app.event('app_mention', async ({ event, say }) => {
    if (event.channel !== config.SLACK_CHANNEL_ID) {
      await say({ text: 'Solo trabajo desde el canal privado configurado.', thread_ts: event.ts });
      return;
    }
    const parsed = parseRequest(event.text ?? '');
    if (!parsed) {
      await say({ text: usage, thread_ts: event.ts });
      return;
    }
    const requestedBy = event.user ? `<@${event.user}>` : 'alguien en Slack';
    ticketLogger(parsed.key, { source: 'manual' }).info({ via: 'mention', user: event.user }, 'Solicitud manual por mención');
    intake
      .receive({ key: parsed.key, source: 'manual', requestedBy, sourceBranch: parsed.sourceBranch, notes: parsed.notes })
      .catch((err: unknown) => log.error({ err, ticket: parsed.key }, 'Fallo procesando la mención'));
  });

  // B) Manual por slash command: "/fix AN-1234 [desde develop]"
  app.command('/fix', async ({ command, ack }) => {
    if (command.channel_id !== config.SLACK_CHANNEL_ID) {
      await ack({ response_type: 'ephemeral', text: 'Usa este comando dentro del canal privado configurado.' });
      return;
    }
    const parsed = parseRequest(command.text ?? '', { freeNotes: true });
    if (!parsed) {
      await ack({ response_type: 'ephemeral', text: usage });
      return;
    }
    await ack({
      response_type: 'ephemeral',
      text: `Recibido, abro un hilo para *${parsed.key}*${parsed.sourceBranch ? ` desde \`${parsed.sourceBranch}\`` : ''}${parsed.notes ? ' con tus notas' : ''}.`,
    });
    ticketLogger(parsed.key, { source: 'manual' }).info({ via: 'command', user: command.user_id, notes: Boolean(parsed.notes) }, 'Solicitud manual por /fix');
    intake
      .receive({ key: parsed.key, source: 'manual', requestedBy: `<@${command.user_id}>`, sourceBranch: parsed.sourceBranch, notes: parsed.notes })
      .catch((err: unknown) => log.error({ err, ticket: parsed.key }, 'Fallo procesando /fix'));
  });

  // Búsqueda del desplegable de ramas: Slack pide opciones al escribir; filtramos sobre el remoto.
  app.options<'block_suggestion'>({ action_id: 'select_branch' }, async ({ options, ack }) => {
    const query = (options.value ?? '').trim().toLowerCase();
    let branches: string[] = [];
    try {
      branches = await intake.listBranches();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'No se pudieron listar ramas para el desplegable');
    }
    const matches: types.PlainTextOption[] = (query ? branches.filter((b) => b.toLowerCase().includes(query)) : branches)
      .filter((b) => b.length <= 75)
      .slice(0, 100)
      .map((b) => ({ text: { type: 'plain_text', text: b }, value: b }));
    await ack({ options: matches });
  });

  // Rama elegida en el desplegable: el block_id lleva el id del job.
  app.action({ action_id: 'select_branch' }, async ({ ack, body, action, respond }) => {
    await ack();
    if ((action.type !== 'external_select' && action.type !== 'static_select') || body.type !== 'block_actions') return;
    const jobId = action.block_id.split(':')[1];
    const branch = action.selected_option?.value;
    if (!jobId || !branch) return;
    const who = `<@${body.user.id}>`;
    try {
      await intake.answer(jobId, branch, 'slack', who);
      await respond({ replace_original: true, text: `Rama origen elegida por ${who}: \`${branch}\`` });
    } catch (err) {
      log.error({ err, jobId, branch }, 'Fallo procesando la rama elegida');
      await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude aplicar esa rama: ${(err as Error).message}` });
    }
  });

  // Botones de repositorios (triaje o needs_repos): confirmar crea los worktrees; rechazar avisa a Claude.
  app.action({ action_id: 'confirm_repos' }, async ({ ack, body, action, respond }) => {
    await ack();
    if (action.type !== 'button' || body.type !== 'block_actions') return;
    const who = `<@${body.user.id}>`;
    try {
      const job = await intake.confirmRepos(action.value ?? '', undefined, 'slack', who);
      await respond({
        replace_original: true,
        text: `Repositorios confirmados por ${who}: ${intake.reposOf(job.id).join(', ')}. Creando worktrees…`,
      });
    } catch (err) {
      log.error({ err }, 'Fallo confirmando repos');
      await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude confirmar: ${(err as Error).message}` });
    }
  });

  app.action({ action_id: 'reject_repos' }, async ({ ack, body, action, respond }) => {
    await ack();
    if (action.type !== 'button' || body.type !== 'block_actions') return;
    const who = `<@${body.user.id}>`;
    try {
      await intake.rejectRepos(action.value ?? '', 'slack', who);
      await respond({ replace_original: true, text: `Propuesta de repositorios rechazada por ${who}.` });
    } catch (err) {
      log.error({ err }, 'Fallo rechazando repos');
      await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude rechazar: ${(err as Error).message}` });
    }
  });

  // Estado en Jira: única escritura, siempre confirmada.
  for (const [actionId, accept] of [['jira_yes', true], ['jira_no', false]] as const) {
    app.action({ action_id: actionId }, async ({ ack, body, action, respond }) => {
      await ack();
      if (action.type !== 'button' || body.type !== 'block_actions') return;
      const who = `<@${body.user.id}>`;
      try {
        await intake.jiraDecision(action.value ?? '', accept, 'slack', who);
        await respond({ replace_original: true, text: accept ? `${who} pidió cambiar el estado en Jira.` : `${who} prefiere no tocar el estado en Jira.` });
      } catch (err) {
        log.error({ err, actionId }, 'Fallo resolviendo el estado en Jira');
        await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude aplicarlo: ${(err as Error).message}` });
      }
    });
  }

  // Fix sin spec de regresión: aceptar sin spec o descartar. Nadie lo decide por el equipo.
  for (const [actionId, accept] of [['regression_accept', true], ['regression_discard', false]] as const) {
    app.action({ action_id: actionId }, async ({ ack, body, action, respond }) => {
      await ack();
      if (action.type !== 'button' || body.type !== 'block_actions') return;
      const who = `<@${body.user.id}>`;
      try {
        await respond({ replace_original: true, text: accept ? `${who} aceptó el fix sin spec de regresión.` : `${who} descartó el job por falta de spec.` });
        await intake.regressionDecision(action.value ?? '', accept, 'slack', who);
      } catch (err) {
        log.error({ err, actionId }, 'Fallo resolviendo el spec de regresión');
        await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude aplicarlo: ${(err as Error).message}` });
      }
    });
  }

  // Subir la rama y abrir el PR hacia la rama origen (nunca push directo ni merge).
  for (const [actionId, accept] of [['pr_open', true], ['pr_skip', false]] as const) {
    app.action({ action_id: actionId }, async ({ ack, body, action, respond }) => {
      await ack();
      if (action.type !== 'button' || body.type !== 'block_actions') return;
      const who = `<@${body.user.id}>`;
      try {
        await respond({ replace_original: true, text: accept ? `${who} pidió subir la rama y abrir el PR…` : `${who} prefiere subir la rama a mano.` });
        await intake.pullRequestDecision(action.value ?? '', accept, 'slack', who);
      } catch (err) {
        log.error({ err, actionId }, 'Fallo abriendo el PR');
        await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude hacerlo: ${(err as Error).message}` });
      }
    });
  }

  // Tras el PR: mover (o no) el ticket al estado de espera de merge.
  for (const [actionId, accept] of [['jira_merge_yes', true], ['jira_merge_no', false]] as const) {
    app.action({ action_id: actionId }, async ({ ack, body, action, respond }) => {
      await ack();
      if (action.type !== 'button' || body.type !== 'block_actions') return;
      const who = `<@${body.user.id}>`;
      try {
        await intake.jiraMergeDecision(action.value ?? '', accept, 'slack', who);
        await respond({ replace_original: true, text: accept ? `${who} pidió mover el ticket tras el PR.` : `${who} deja el estado del ticket como está.` });
      } catch (err) {
        log.error({ err, actionId }, 'Fallo moviendo el ticket tras el PR');
        await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude aplicarlo: ${(err as Error).message}` });
      }
    });
  }

  // Publicar (o no) el reporte del fix en el ticket de Jira.
  for (const [actionId, accept] of [['jira_comment_yes', true], ['jira_comment_no', false]] as const) {
    app.action({ action_id: actionId }, async ({ ack, body, action, respond }) => {
      await ack();
      if (action.type !== 'button' || body.type !== 'block_actions') return;
      const who = `<@${body.user.id}>`;
      try {
        await intake.publishJiraComment(action.value ?? '', accept, 'slack', who);
        await respond({ replace_original: true, text: accept ? `Reporte publicado en Jira por ${who}.` : `${who} prefiere no publicar el reporte en Jira.` });
      } catch (err) {
        log.error({ err, actionId }, 'Fallo publicando el reporte en Jira');
        await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude publicarlo: ${(err as Error).message}` });
      }
    });
  }

  // Sin entorno de reproducción: el equipo decide si arreglar a ciegas o descartar.
  app.action({ action_id: 'env_code_only' }, async ({ ack, body, action, respond }) => {
    await ack();
    if (action.type !== 'button' || body.type !== 'block_actions') return;
    const who = `<@${body.user.id}>`;
    try {
      await intake.continueWithoutEnv(action.value ?? '', 'slack', who);
      await respond({ replace_original: true, text: `${who} eligió corregir solo con código (sin reproducción en navegador).` });
    } catch (err) {
      log.error({ err }, 'Fallo aplicando "solo código"');
      await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude continuar: ${(err as Error).message}` });
    }
  });

  app.action({ action_id: 'env_retry' }, async ({ ack, body, action, respond }) => {
    await ack();
    if (action.type !== 'button' || body.type !== 'block_actions') return;
    const who = `<@${body.user.id}>`;
    try {
      await respond({ replace_original: true, text: `${who} pidió reintentar el entorno de reproducción.` });
      await intake.retryEnvironment(action.value ?? '', 'slack', who);
    } catch (err) {
      log.error({ err }, 'Fallo reintentando el entorno');
      await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude reintentar: ${(err as Error).message}` });
    }
  });

  app.action({ action_id: 'env_discard' }, async ({ ack, body, action, respond }) => {
    await ack();
    if (action.type !== 'button' || body.type !== 'block_actions') return;
    const who = `<@${body.user.id}>`;
    try {
      await intake.discard(action.value ?? '', 'sin entorno de reproducción', who);
      await respond({ replace_original: true, text: `Job descartado por ${who} (sin entorno de reproducción).` });
    } catch (err) {
      log.error({ err }, 'Fallo descartando por entorno');
      await respond({ replace_original: false, response_type: 'ephemeral', text: `No pude descartar: ${(err as Error).message}` });
    }
  });

  // Respuestas humanas dentro de un hilo: si el hilo pertenece a un job en awaiting_*,
  // la respuesta se registra y saca al job de la espera (Intake decide qué hacer después).
  app.message(async ({ message }) => {
    if (message.channel !== config.SLACK_CHANNEL_ID) return;
    if (message.subtype !== undefined) return; // ediciones, joins, bots, etc.
    if (!('thread_ts' in message) || !message.thread_ts || !('text' in message) || !message.text) return;
    if (message.thread_ts === message.ts) return; // es el mensaje raíz, no una respuesta
    const userId = 'user' in message && message.user ? message.user : 'desconocido';
    try {
      await intake.answerFromThread(message.channel, message.thread_ts, message.text, userId);
    } catch (err) {
      log.error({ err, thread: message.thread_ts }, 'Fallo procesando respuesta en hilo');
    }
  });
}
