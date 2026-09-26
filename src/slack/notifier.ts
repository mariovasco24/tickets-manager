import path from 'node:path';
import type { types, webApi } from '@slack/bolt';
import type { IncomingBug, JiraIssue, ThreadRef } from '../types.js';

type WebClient = webApi.WebClient;
type KnownBlock = types.KnownBlock;

const SOURCE_LABEL: Record<IncomingBug['source'], string> = {
  webhook: 'webhook de Jira',
  manual: 'manual (Slack)',
  voice: 'por voz (DABOT)',
};

/**
 * Toda la comunicación hacia Slack pasa por aquí. Cada ticket vive en un hilo
 * del canal privado configurado; el mensaje raíz identifica el ticket y las
 * respuestas van siempre con `thread_ts`.
 */
export class SlackNotifier {
  constructor(
    private readonly client: WebClient,
    private readonly channel: string,
  ) {}

  async openThread(issue: JiraIssue, bug: IncomingBug): Promise<ThreadRef> {
    const title = `:bug: *<${issue.url}|${issue.key}>* — ${escape(issue.summary)}`;
    const meta = [
      `*Estado Jira:* ${escape(issue.status)}`,
      `*Origen:* ${SOURCE_LABEL[bug.source]}`,
      `*Solicitado por:* ${bug.requestedBy}`,
      bug.sourceBranch ? `*Rama origen:* \`${escape(bug.sourceBranch)}\`` : undefined,
    ]
      .filter(Boolean)
      .join('  ·  ');

    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: title } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: meta }] },
    ];
    if (bug.notes) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:memo: *Notas del equipo:* ${escape(bug.notes)}` } });
    }

    const res = await this.client.chat.postMessage({
      channel: this.channel,
      text: `${issue.key} — ${issue.summary}`,
      blocks,
      unfurl_links: false,
    });
    if (!res.ts) throw new Error('Slack no devolvió ts al abrir el hilo');
    return { channel: this.channel, ts: res.ts };
  }

  async reply(thread: ThreadRef, text: string, blocks?: KnownBlock[]): Promise<string | undefined> {
    const res = await this.client.chat.postMessage({
      channel: thread.channel,
      thread_ts: thread.ts,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
    });
    return res.ts;
  }

  /**
   * Pregunta la rama origen con un desplegable con búsqueda (external_select):
   * al escribir, Slack pide las opciones al servicio, que filtra sobre las ramas
   * reales del remoto. Así no importa que haya más de 100 ramas.
   */
  async askBranch(thread: ThreadRef, jobId: string, question: string, branchCount: number): Promise<string | undefined> {
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${escape(question)}*` } },
      {
        type: 'actions',
        block_id: `branch_select:${jobId}`,
        elements: [
          {
            type: 'external_select',
            action_id: 'select_branch',
            placeholder: { type: 'plain_text', text: 'Escribe para buscar la rama (p. ej. release/9.5)' },
            min_query_length: 0,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${branchCount} ramas en el remoto. También puedes escribir el nombre de la rama en este hilo o responder desde el dashboard.`,
          },
        ],
      },
    ];
    return this.reply(thread, question, blocks);
  }

  /**
   * Propone los repositorios en los que trabajar (triaje o needs_repos) con
   * botones Confirmar / Rechazar. Cambiar la lista se hace escribiendo en el
   * hilo "repos: a, b" o desde el dashboard.
   */
  async askRepos(
    thread: ThreadRef,
    jobId: string,
    title: string,
    repos: Array<{ name: string; reason: string; confidence?: string; cloned: boolean }>,
    analysis?: string,
  ): Promise<string | undefined> {
    const list = repos
      .map(
        (r) =>
          `• *${escape(r.name)}*${r.confidence ? ` _(${r.confidence})_` : ''}${r.cloned ? '' : ' :inbox_tray: _se clonará_'}${r.reason ? ` — ${escape(r.reason)}` : ''}`,
      )
      .join('\n');
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${escape(title)}*\n${list}` } },
    ];
    if (analysis) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escape(analysis).slice(0, 2900) }] });
    }
    blocks.push({
      type: 'actions',
      block_id: `repos:${jobId}`,
      elements: [
        {
          type: 'button',
          action_id: 'confirm_repos',
          style: 'primary',
          text: { type: 'plain_text', text: 'Confirmar y crear worktrees' },
          value: jobId,
        },
        {
          type: 'button',
          action_id: 'reject_repos',
          style: 'danger',
          text: { type: 'plain_text', text: 'Rechazar' },
          value: jobId,
        },
      ],
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Para cambiar la lista escribe en este hilo `repos: nombre1, nombre2` (nombres del manifest) y luego confirma.' }],
    });
    return this.reply(thread, title, blocks);
  }

  /**
   * Pregunta qué hacer cuando no hay entorno donde reproducir el bug. Solo dos
   * salidas: arreglar mirando el código, o descartar el job.
   */
  async askEnvDecision(thread: ThreadRef, jobId: string, question: string, detail?: string): Promise<string | undefined> {
    const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: `:warning: ${escape(question)}` } }];
    if (detail) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${escape(detail).slice(0, 2600)}\n\`\`\`` } });
    }
    blocks.push({
      type: 'actions',
      block_id: `env:${jobId}`,
      elements: [
        { type: 'button', action_id: 'env_code_only', style: 'primary', text: { type: 'plain_text', text: 'Corregir solo con código' }, value: jobId },
        { type: 'button', action_id: 'env_retry', text: { type: 'plain_text', text: 'Reintentar entorno' }, value: jobId },
        { type: 'button', action_id: 'env_discard', style: 'danger', text: { type: 'plain_text', text: 'Descartar' }, value: jobId },
      ],
    });
    return this.reply(thread, question, blocks);
  }

  /**
   * Pregunta si mover el ticket a "en curso" en Jira. Es la única escritura que
   * el servicio hace en Jira, así que siempre pasa por aquí.
   */
  async askJiraStatus(thread: ThreadRef, jobId: string, question: string): Promise<string | undefined> {
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: question } },
      {
        type: 'actions',
        block_id: `jira:${jobId}`,
        elements: [
          { type: 'button', action_id: 'jira_yes', style: 'primary', text: { type: 'plain_text', text: 'Sí, cambiar estado' }, value: jobId },
          { type: 'button', action_id: 'jira_no', text: { type: 'plain_text', text: 'No, dejarlo igual' }, value: jobId },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Es el único cambio que este bot hace en Jira. Con "No" continúo sin tocar el ticket.' }] },
    ];
    return this.reply(thread, question, blocks);
  }

  /** El fix no quedó cubierto por un spec y Claude dice que no puede: una persona decide. */
  async askRegressionDecision(thread: ThreadRef, jobId: string, question: string, detail: string | undefined): Promise<string | undefined> {
    const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: `:test_tube: ${question}` } }];
    if (detail) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${escape(detail).slice(0, 2600)}\n\`\`\`` } });
    blocks.push({
      type: 'actions',
      block_id: `regression:${jobId}`,
      elements: [
        { type: 'button', action_id: 'regression_accept', text: { type: 'plain_text', text: 'Aceptar sin spec' }, value: jobId },
        { type: 'button', action_id: 'regression_discard', style: 'danger', text: { type: 'plain_text', text: 'Descartar' }, value: jobId },
      ],
    });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'También puedes escribir en el hilo para darle indicaciones a Claude Code (dónde o cómo escribir el spec).' }] });
    return this.reply(thread, question, blocks);
  }

  /** Ofrece subir la rama y abrir el pull request hacia la rama origen. Nunca se hace sin confirmación. */
  async askPullRequest(thread: ThreadRef, jobId: string, branch: string, sourceBranch: string, repos: string[], retry = false): Promise<string | undefined> {
    const question = retry
      ? `Cuando lo hayas corregido, ¿reintento abrir el pull request de \`${branch}\` hacia \`${sourceBranch}\`? Lo ya commiteado o subido no se repite.`
      : `¿Subo la rama \`${branch}\` y abro el pull request hacia \`${sourceBranch}\`${repos.length > 1 ? ` en ${repos.join(', ')}` : ''}?`;
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: question } },
      {
        type: 'actions',
        block_id: `pr:${jobId}`,
        elements: [
          { type: 'button', action_id: 'pr_open', style: 'primary', text: { type: 'plain_text', text: 'Sí, subir y abrir PR' }, value: jobId },
          { type: 'button', action_id: 'pr_skip', text: { type: 'plain_text', text: 'No, lo hago yo' }, value: jobId },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Commitea los cambios del worktree con "fix(KEY): :bug: <título del ticket>" (pasando por los hooks del repo), sube la rama con su nombre y deja el PR abierto. Nunca empuja a la rama origen ni mergea.',
          },
        ],
      },
    ];
    return this.reply(thread, question, blocks);
  }

  /** Tras abrir el PR: ofrece mover el ticket al estado de espera de merge. Siempre con confirmación. */
  async askJiraMerge(thread: ThreadRef, jobId: string, question: string): Promise<string | undefined> {
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: question } },
      {
        type: 'actions',
        block_id: `jiramerge:${jobId}`,
        elements: [
          { type: 'button', action_id: 'jira_merge_yes', style: 'primary', text: { type: 'plain_text', text: 'Sí, mover' }, value: jobId },
          { type: 'button', action_id: 'jira_merge_no', text: { type: 'plain_text', text: 'No, dejarlo' }, value: jobId },
        ],
      },
    ];
    return this.reply(thread, question, blocks);
  }

  /** Ofrece publicar el reporte del fix en el ticket, con los vídeos adjuntos. */
  async askJiraComment(thread: ThreadRef, jobId: string, ticketKey: string, videos: number): Promise<string | undefined> {
    const question = `¿Publico el reporte en *${ticketKey}* como comentario${videos ? ` con ${videos} vídeo(s) adjunto(s)` : ''}?`;
    const blocks: KnownBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: question } },
      {
        type: 'actions',
        block_id: `jiracomment:${jobId}`,
        elements: [
          { type: 'button', action_id: 'jira_comment_yes', style: 'primary', text: { type: 'plain_text', text: 'Sí, publicar' }, value: jobId },
          { type: 'button', action_id: 'jira_comment_no', text: { type: 'plain_text', text: 'No publicar' }, value: jobId },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Se publica el mismo reporte que ves arriba: Issue, Solution, Notes for QA, rama, archivos, tests y reproducción.' }] },
    ];
    return this.reply(thread, question, blocks);
  }

  /** Sube un archivo al hilo (vídeos y capturas de la reproducción). */
  async uploadFile(thread: ThreadRef, filePath: string, title: string, comment?: string): Promise<void> {
    await this.client.files.uploadV2({
      channel_id: thread.channel,
      thread_ts: thread.ts,
      file: filePath,
      filename: path.basename(filePath),
      title,
      ...(comment ? { initial_comment: comment } : {}),
    });
  }

  /** Sustituye un mensaje (p. ej. el desplegable ya usado) por texto plano. */
  async replaceMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.client.chat.update({ channel, ts, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  }

  /** Aviso fuera de hilo (por ejemplo, un ticket que no se pudo leer en Jira). */
  async postToChannel(text: string): Promise<void> {
    await this.client.chat.postMessage({ channel: this.channel, text, unfurl_links: false });
  }

  permalink(thread: ThreadRef): Promise<string | undefined> {
    return this.client.chat
      .getPermalink({ channel: thread.channel, message_ts: thread.ts })
      .then((r) => r.permalink);
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
