import type { SseHub } from '../api/sse.js';
import type { Intake } from '../intake.js';
import type { JobService } from '../jobs/service.js';
import { logger } from '../logger.js';
import { STATUS_LABELS, isTerminal, type JobDetailDto, type JobDto } from '../shared/job-types.js';
import { pendingDecision, shorten, type DecisionContext, type VoiceDecision } from './decision.js';
import { matchBranch, parseIntent, type VoiceIntent } from './parse.js';
import { plain, spell, toSpeech } from './speech.js';

/** Quién aparece en el hilo de Slack y en la bitácora cuando decide DABOT. */
export const VOICE_WHO = 'DABOT (voz)';

/** Tiempo que la respuesta espera a la acción: los errores de validación se dicen en la misma respuesta. */
const ACTION_GRACE_MS = 1500;

export interface VoiceOptions {
  defaultProject: string;
  projects: string[];
  announce: 'all' | 'voice';
  prEnabled: boolean;
  jiraMergeStatus: string | undefined;
  jiraAllowComment: boolean;
}

/** Lo que la tablet necesita de un job: tarjeta en pantalla, nada de rutas locales. */
export interface VoiceJob {
  id: string;
  ticketKey: string;
  summary: string | null;
  status: JobDto['status'];
  statusLabel: string;
  source: JobDto['source'];
  issue: string | null;
  solution: string | null;
  testsResult: JobDto['testsResult'];
  failureReason: string | null;
  prUrls: string[];
  slackPermalink: string | null;
  updatedAt: number;
}

export interface VoiceReply {
  /** Lo que DABOT dice. */
  say: string;
  /** Texto en pantalla (si difiere de lo hablado). */
  display?: string;
  /** Escuchar la respuesta sin palabra de activación. */
  listen: boolean;
  job?: VoiceJob;
  decision?: VoiceDecision;
}

export interface VoiceAnnouncement extends VoiceReply {
  id: number;
  jobId: string;
}

export interface VoiceState {
  jobs: VoiceJob[];
  focus?: { job: VoiceJob; decision?: VoiceDecision };
  say: string;
}

/**
 * DABOT: la tablet solo transcribe y habla; aquí se interpreta lo que dices y
 * se ejecuta por las mismas funciones que los botones de Slack y el dashboard,
 * así que las confirmaciones de Jira, PR y comentario son exactamente las
 * mismas. Cada cambio relevante de un job se anuncia por su propio canal SSE.
 */
export class VoiceService {
  private readonly log = logger().child({ component: 'voice' });
  /** Última situación anunciada por job, para no repetir. */
  private readonly signatures = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  /** Mientras se responde un comando, los anuncios esperan: primero la respuesta, luego lo siguiente. */
  private holds = 0;
  private held: VoiceAnnouncement[] = [];
  private focusJobId: string | undefined;
  private focusKey: string | undefined;
  private pendingDiscard: string | undefined;
  private lastSaid: VoiceReply | undefined;

  constructor(
    private readonly intake: Intake,
    private readonly jobs: JobService,
    private readonly hub: SseHub,
    private readonly opts: VoiceOptions,
  ) {
    // Lo que ya estaba así al arrancar no se vuelve a anunciar.
    for (const job of jobs.list()) {
      if (isTerminal(job.status) && job.status !== 'fixed') continue;
      const detail = jobs.getDetail(job.id);
      if (detail) this.signatures.set(job.id, this.signature(detail, this.decisionFor(detail, [])));
    }
    jobs.on('job', (job: JobDto) => {
      this.chain = this.chain.then(() => this.announceFor(job.id)).catch((err: unknown) => this.log.error({ err }, 'Fallo preparando un anuncio'));
    });
  }

  // ---------------------------------------------------------------------------
  // Entrada
  // ---------------------------------------------------------------------------

  /** Retiene los anuncios hasta llamar a la función devuelta (tras enviar la respuesta HTTP). */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0) {
        const queued = this.held;
        this.held = [];
        for (const a of queued) this.hub.broadcast('voice', a);
      }
    };
  }

  async state(): Promise<VoiceState> {
    const focus = await this.focus();
    const list = this.visibleJobs();
    const say = focus?.decision
      ? focus.decision.speech
      : list.some((j) => !isTerminal(j.status))
        ? toSpeech(this.statusSentence(list))
        : 'Hola. Dime qué ticket arreglo.';
    return { jobs: list, ...(focus ? { focus } : {}), say };
  }

  async command(text: string, jobId?: string): Promise<VoiceReply> {
    const intent = parseIntent(text, this.opts);
    this.log.info({ intent: intent.type, text }, 'Comando de voz');
    const reply = await this.handle(intent, text, jobId);
    if (intent.type !== 'repeat') this.lastSaid = reply;
    return reply;
  }

  /** Opción tocada en la pantalla (o dicha por número). */
  async decide(jobId: string, optionId: string): Promise<VoiceReply> {
    const detail = this.jobs.getDetail(jobId);
    if (!detail) return { say: 'Ese job ya no existe.', listen: false };
    const decision = this.decisionFor(detail, await this.branches());
    if (!decision) return { say: `${spell(detail.ticketKey)} no está esperando nada ahora.`, listen: false, job: this.voiceJob(detail) };
    return this.execute(decision, optionId);
  }

  // ---------------------------------------------------------------------------
  // Interpretación
  // ---------------------------------------------------------------------------

  private async handle(intent: VoiceIntent, text: string, jobId: string | undefined): Promise<VoiceReply> {
    switch (intent.type) {
      case 'cancel':
        this.pendingDiscard = undefined;
        return { say: 'Vale.', listen: false };
      case 'help':
        return {
          say: 'Dime, por ejemplo: arregla el ticket A N 1234 desde develop. Luego te iré preguntando lo mismo que en Slack, y respondes sí, no, o el número de la opción. Para hablar con Claude empieza con: dile a Claude.',
          listen: false,
        };
      case 'repeat':
        return this.lastSaid ?? (await this.statusReply());
      case 'status':
        return this.statusReply();
      case 'fix':
        return this.startFix(intent);
      case 'discard':
        return this.askDiscard(intent.ticket?.key, jobId);
      case 'message':
        return this.sendMessage(intent.text, jobId);
      default:
        break;
    }

    // Respuesta a la confirmación de descarte.
    if (this.pendingDiscard) {
      const target = this.pendingDiscard;
      this.pendingDiscard = undefined;
      if (intent.type === 'yes') {
        return this.run(target, () => this.intake.discard(target, 'descartado por voz', VOICE_WHO), 'Descartado.');
      }
      return { say: 'Vale, no lo descarto.', listen: false };
    }

    const focus = await this.focus(jobId);
    if (!focus?.decision) {
      // Decir lo que se oyó: si falla, casi siempre es la transcripción, y así se ve al momento.
      const heard = intent.type === 'text' ? `Oí: ${intent.text}. ` : '';
      return {
        say: `${heard}No encontré un ticket en eso y no hay nada pendiente. Di, por ejemplo: arregla el ticket A N 1234.`,
        display: intent.type === 'text' ? `Oí: «${intent.text}»\nNo encontré un ticket. Ejemplo: «arregla el ticket AN-1234»` : undefined,
        listen: false,
        ...(focus ? { job: focus.job } : {}),
      };
    }
    const d = focus.decision;

    // Claude preguntó: cualquier respuesta (también "sí" o "no") va tal cual a la sesión.
    if (d.kind === 'clarification') return this.execute(d, 'answer', text);

    switch (intent.type) {
      case 'yes':
        if (d.kind === 'branch') return this.again(d, 'Dime el nombre de la rama o el número de la lista.');
        return this.execute(d, d.options[0]!.id);
      case 'no':
        if (d.kind === 'branch') return this.again(d, 'Necesito una rama para seguir. Dime cuál, o di descarta.');
        return this.execute(d, (d.options[1] ?? d.options[0]!).id);
      case 'option': {
        const opt = d.options[intent.index];
        return opt ? this.execute(d, opt.id) : this.again(d, `No hay opción ${intent.index + 1}.`);
      }
      case 'code_only':
      case 'retry':
        return d.kind === 'env' ? this.execute(d, intent.type) : this.again(d, 'Eso no aplica ahora.');
      case 'text':
        if (d.kind === 'branch') {
          const branch = matchBranch(intent.text, await this.branches());
          return branch ? this.execute(d, `branch:${branch}`) : this.again(d, `No encuentro la rama ${intent.text}.`);
        }
        if (d.kind === 'repos') {
          const list = intent.text
            .replace(/^(los |el )?(repos?|repositorios?)\s*:?\s*/i, '')
            .split(/\s*(?:,|\by\b)\s*/)
            .map((s) => s.trim().replace(/\s+/g, '-'))
            .filter(Boolean);
          return this.execute(d, 'confirm', undefined, list);
        }
        return this.again(d, 'No te entendí.');
      default:
        return this.again(d, 'No te entendí.');
    }
  }

  private async startFix(intent: Extract<VoiceIntent, { type: 'fix' }>): Promise<VoiceReply> {
    const { key, assumedProject } = intent.ticket;
    const active = this.jobs.findActiveByTicket(key);
    if (active) {
      this.focusJobId = active.id;
      const detail = this.jobs.getDetail(active.id);
      const decision = detail ? this.decisionFor(detail, await this.branches()) : undefined;
      return {
        say: toSpeech(`${key} ya está en marcha: ${STATUS_LABELS[active.status].toLowerCase()}.${decision ? ` ${decision.speech}` : ''}`, 600),
        listen: Boolean(decision),
        job: this.voiceJob(active),
        ...(decision ? { decision } : {}),
      };
    }

    let branch: string | undefined;
    let branchNote = '';
    if (intent.branch) {
      branch = matchBranch(intent.branch, await this.branches());
      if (!branch) branchNote = ` No encuentro la rama ${intent.branch}; te preguntaré cuál.`;
    }

    this.focusKey = key;
    this.focusJobId = undefined;
    this.intake
      .receive({ key, source: 'voice', requestedBy: VOICE_WHO, ...(branch ? { sourceBranch: branch } : {}), ...(intent.notes ? { notes: intent.notes } : {}) })
      .catch((err: unknown) => {
        this.log.error({ err, ticket: key }, 'Fallo iniciando el job por voz');
        this.emit({ id: ++this.seq, jobId: '', say: `No pude empezar con ${spell(key)}: ${toSpeech((err as Error).message)}`, listen: false });
      });

    const check = assumedProject ? ` Entendí ${spell(key)}; si no es ese, di descarta.` : '';
    const notes = intent.notes ? ' Con tus notas.' : '';
    return {
      say: `Vale, voy con ${spell(key)}${branch ? ` desde ${toSpeech(branch)}` : ''}.${notes}${branchNote}${check}`,
      display: `Voy con ${key}${branch ? ` desde ${branch}` : ''}${intent.notes ? `\nNotas: ${intent.notes}` : ''}`,
      listen: false,
    };
  }

  private async askDiscard(key: string | undefined, jobId: string | undefined): Promise<VoiceReply> {
    const targetId = key ? this.jobs.findActiveByTicket(key)?.id : (await this.focus(jobId))?.job.id;
    const target = targetId ? this.jobs.get(targetId) : undefined;
    if (!target || isTerminal(target.status)) return { say: key ? `${spell(key)} no tiene un job activo.` : 'No tengo ningún job activo que descartar.', listen: false };
    this.pendingDiscard = target.id;
    return { say: `¿Seguro que descarto ${spell(target.ticketKey)}?`, listen: true, job: this.voiceJob(target) };
  }

  private async sendMessage(text: string, jobId: string | undefined): Promise<VoiceReply> {
    const focus = await this.focus(jobId);
    if (!focus) return { say: 'No hay ningún job al que pasárselo.', listen: false };
    if (!text) return { say: '¿Qué le digo a Claude?', listen: false };
    const status = focus.job.status;
    const ack =
      status === 'working' || status === 'triaging'
        ? 'Anotado, se lo paso a Claude cuando termine el turno.'
        : status === 'discarded'
          ? ''
          : `Se lo paso a Claude en ${spell(focus.job.ticketKey)}.`;
    if (!ack) return { say: 'Ese job está descartado. Pídeme el ticket de nuevo.', listen: false };
    return this.run(focus.job.id, () => this.intake.humanMessage(focus.job.id, text, 'voice', VOICE_WHO), ack);
  }

  // ---------------------------------------------------------------------------
  // Ejecución de decisiones
  // ---------------------------------------------------------------------------

  private async execute(d: VoiceDecision, optionId: string, text?: string, repos?: string[]): Promise<VoiceReply> {
    const id = d.jobId;
    const key = spell(d.ticketKey);
    const i = this.intake;
    this.focusJobId = id;

    switch (d.kind) {
      case 'jira_status':
        return this.run(id, () => i.jiraDecision(id, optionId === 'yes', 'voice', VOICE_WHO), optionId === 'yes' ? 'Cambio el estado en Jira.' : 'Dejo Jira como está.');
      case 'branch': {
        const branch = optionId.startsWith('branch:') ? optionId.slice('branch:'.length) : undefined;
        if (!branch) return this.again(d, 'Dime la rama.');
        return this.run(id, () => i.answer(id, branch, 'voice', VOICE_WHO), `Rama ${toSpeech(branch)}. Busco en qué repositorios está el bug.`);
      }
      case 'repos':
        return optionId === 'reject'
          ? this.run(id, () => i.rejectRepos(id, 'voice', VOICE_WHO), 'Rechazados.')
          : this.run(id, () => i.confirmRepos(id, repos?.length ? repos : undefined, 'voice', VOICE_WHO), 'Confirmados. Preparo los worktrees.');
      case 'env':
        if (optionId === 'discard') return this.run(id, () => i.discard(id, 'sin entorno de reproducción', VOICE_WHO), 'Descartado.');
        if (optionId === 'retry') return this.run(id, () => i.retryEnvironment(id, 'voice', VOICE_WHO), 'Reintento el entorno.');
        return this.run(id, () => i.continueWithoutEnv(id, 'voice', VOICE_WHO), 'Sigo solo con código.');
      case 'regression':
        return this.run(id, () => i.regressionDecision(id, optionId === 'accept', 'voice', VOICE_WHO), optionId === 'accept' ? 'Aceptado sin spec.' : 'Descartado.');
      case 'clarification':
        if (!text?.trim()) return this.again(d, 'Dime la respuesta para Claude.');
        return this.run(id, () => i.answer(id, text, 'voice', VOICE_WHO), 'Se lo paso a Claude.');
      case 'pull_request':
        return this.run(id, () => i.pullRequestDecision(id, optionId === 'open', 'voice', VOICE_WHO), optionId === 'open' ? `Subo la rama y abro el PR de ${key}.` : 'Sin PR.');
      case 'jira_merge':
        return this.run(id, () => i.jiraMergeDecision(id, optionId === 'transition', 'voice', VOICE_WHO), optionId === 'transition' ? 'Lo muevo en Jira.' : 'Dejo el estado.');
      case 'jira_comment':
        return this.run(id, () => i.publishJiraComment(id, optionId === 'publish', 'voice', VOICE_WHO), optionId === 'publish' ? 'Publico el reporte en Jira.' : 'No lo publico.');
    }
  }

  /**
   * Lanza la acción y espera un momento: un error de validación (rama que no
   * existe, estado cambiado) se dice en la respuesta; lo que tarde más sigue en
   * segundo plano y, si falla, se anuncia.
   */
  private async run(jobId: string, action: () => Promise<unknown>, ack: string): Promise<VoiceReply> {
    const pending = action();
    const outcome = await Promise.race([
      pending.then(
        () => 'done' as const,
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      ),
      new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), ACTION_GRACE_MS)),
    ]);
    // Estado real del job al responder (con su decisión pendiente): la tablet no debe
    // deducir nada de una respuesta que llegue después del anuncio de la siguiente pregunta.
    const detail = this.jobs.getDetail(jobId);
    const now = detail ? { job: this.voiceJob(detail), ...this.withDecision(detail, await this.branches()) } : {};
    if (outcome instanceof Error) {
      this.log.warn({ err: outcome.message, jobId }, 'Acción por voz rechazada');
      return { say: `No pude: ${toSpeech(outcome.message)}`, listen: false, ...now };
    }
    if (outcome === 'running') {
      pending.catch((err: unknown) => {
        this.log.error({ err, jobId }, 'Acción por voz fallida en segundo plano');
        this.emit({ id: ++this.seq, jobId, say: `Algo falló: ${toSpeech((err as Error).message)}`, listen: false });
      });
    }
    return { say: ack, listen: false, ...now };
  }

  private withDecision(detail: JobDetailDto, branches: readonly string[]): { decision?: VoiceDecision } {
    const decision = this.decisionFor(detail, branches);
    return decision ? { decision } : {};
  }

  private again(d: VoiceDecision, prefix: string): VoiceReply {
    const opts = d.options.length ? ` Opciones: ${d.options.map((o, n) => `${n + 1}, ${o.label}`).join('; ')}.` : '';
    const job = this.jobs.get(d.jobId);
    return { say: toSpeech(`${prefix}${opts}`), listen: true, decision: d, ...(job ? { job: this.voiceJob(job) } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Anuncios
  // ---------------------------------------------------------------------------

  private async announceFor(jobId: string): Promise<void> {
    const detail = this.jobs.getDetail(jobId);
    if (!detail) return;
    if (this.opts.announce === 'voice' && detail.source !== 'voice') return;
    const decision = this.decisionFor(detail, await this.branches());
    const sig = this.signature(detail, decision);
    const prev = this.signatures.get(jobId);
    if (sig === prev) return;
    this.signatures.set(jobId, sig);

    const say = this.announcementText(detail, decision, prev);
    if (!say) return;
    if (decision || this.focusKey === detail.ticketKey) this.focusJobId = jobId;
    const a: VoiceAnnouncement = {
      id: ++this.seq,
      jobId,
      say: toSpeech(say, 600),
      display: plain(decision?.question ?? say),
      listen: Boolean(decision),
      job: this.voiceJob(detail),
      ...(decision ? { decision } : {}),
    };
    this.lastSaid = a;
    this.emit(a);
  }

  private announcementText(job: JobDetailDto, decision: VoiceDecision | undefined, prev: string | undefined): string | undefined {
    const k = job.ticketKey;
    const [prevStatus, prevKind] = (prev ?? '').split('|');
    const wasFixed = prevStatus === 'fixed';
    if (decision) {
      let lead = '';
      if (job.status === 'fixed' && !wasFixed) lead = this.fixedSummary(job);
      else if (decision.kind === 'jira_merge') lead = `Pull request abierto para ${k}.`;
      else if (decision.kind === 'jira_comment' && prevKind === 'jira_merge') lead = `${k}:`;
      else if (decision.kind !== 'repos' && decision.kind !== 'branch' && !decision.question.includes(k)) lead = `${k}:`;
      return `${lead} ${decision.speech}`.trim();
    }
    switch (job.status) {
      case 'triaging':
        return `Analizando en qué repositorios está ${k}.`;
      case 'creating_worktree':
        return `Preparo los worktrees de ${k}.`;
      case 'working':
        return prevStatus === 'working' ? undefined : `Claude Code está trabajando en ${k}. Te aviso cuando termine o si tiene preguntas.`;
      case 'fixed':
        return wasFixed ? this.closingLine(job) : `${this.fixedSummary(job)} No hay nada más que confirmar.`;
      case 'cannot_fix':
        return `No pude arreglar ${k}. ${job.failureReason ?? ''}`;
      case 'failed':
        return `${k} falló. ${job.failureReason ?? ''}`;
      case 'discarded':
        return `${k} descartado.`;
      default:
        return undefined;
    }
  }

  /** "Ya terminé con…": resumen del fix para decirlo en voz alta. */
  private fixedSummary(job: JobDetailDto): string {
    const parts = [`Ya terminé con ${job.ticketKey}.`];
    const summary = job.fixSummary ?? job.solution ?? job.issue;
    if (summary) parts.push(shorten(plain(summary), 320));
    const files = job.filesChanged.length;
    if (files) parts.push(`Cambié ${files} archivo${files > 1 ? 's' : ''}.`);
    if (job.testsResult === 'passed') parts.push('Los tests pasan.');
    else if (job.testsResult === 'failed') parts.push('Ojo: hay tests fallando.');
    if (job.regressionTest?.verdict === 'verified') parts.push('El test de regresión falla sin el fix y pasa con él.');
    return parts.join(' ');
  }

  /** Cuando ya no queda nada que confirmar tras el fix. */
  private closingLine(job: JobDetailDto): string {
    const has = (type: string) => job.events.some((e) => e.type === type);
    const done: string[] = [];
    if (job.worktrees.some((w) => w.prUrl)) done.push('PR abierto');
    if (has('jira_merge_transition')) done.push('ticket movido en Jira');
    if (has('jira_comment')) done.push('reporte publicado');
    return `Todo listo con ${job.ticketKey}${done.length ? `: ${done.join(', ')}` : ''}. No queda nada pendiente.`;
  }

  private signature(job: JobDetailDto, decision: VoiceDecision | undefined): string {
    return `${job.status}|${decision?.kind ?? ''}|${decision?.question ?? ''}`;
  }

  private emit(a: VoiceAnnouncement): void {
    if (this.holds > 0) this.held.push(a);
    else this.hub.broadcast('voice', a);
  }

  // ---------------------------------------------------------------------------
  // Estado y foco
  // ---------------------------------------------------------------------------

  private decisionFor(detail: JobDetailDto, branches: readonly string[]): VoiceDecision | undefined {
    const ctx: DecisionContext = {
      prEnabled: this.opts.prEnabled,
      jiraMergeStatus: this.opts.jiraMergeStatus,
      jiraAllowComment: this.opts.jiraAllowComment,
      branches,
    };
    return pendingDecision(detail, ctx);
  }

  /**
   * Job al que se refiere lo que dices: el que muestra la tablet, si sigue
   * esperando algo; si no, el último anunciado con algo pendiente; si no, el
   * activo más reciente.
   */
  private async focus(jobId?: string): Promise<{ job: VoiceJob; decision?: VoiceDecision } | undefined> {
    const branches = await this.branches();
    const withDecision = (id: string | undefined) => {
      const detail = id ? this.jobs.getDetail(id) : undefined;
      const decision = detail ? this.decisionFor(detail, branches) : undefined;
      return detail && decision ? { job: this.voiceJob(detail), decision } : undefined;
    };
    if (this.focusKey) {
      const byKey = this.jobs.findActiveByTicket(this.focusKey);
      if (byKey) {
        this.focusJobId = byKey.id;
        this.focusKey = undefined;
      }
    }
    const found =
      withDecision(jobId) ??
      withDecision(this.focusJobId) ??
      this.jobs
        .list()
        .filter((j) => !isTerminal(j.status) || j.status === 'fixed')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((j) => withDecision(j.id))
        .find(Boolean);
    if (found) return found;
    const fallbackId = jobId ?? this.focusJobId;
    const fallback = (fallbackId ? this.jobs.get(fallbackId) : undefined) ?? this.jobs.list().filter((j) => !isTerminal(j.status)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return fallback ? { job: this.voiceJob(fallback) } : undefined;
  }

  /** Activos, más los terminados en las últimas 12 h (para la lista de la tablet). */
  private visibleJobs(): VoiceJob[] {
    const since = Date.now() - 12 * 3600_000;
    return this.jobs
      .list()
      .filter((j) => !isTerminal(j.status) || j.updatedAt >= since)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12)
      .map((j) => this.voiceJob(j));
  }

  private statusSentence(list: VoiceJob[]): string {
    const active = list.filter((j) => !isTerminal(j.status));
    if (!active.length) return 'No hay nada en marcha.';
    const items = active.map((j) => `${j.ticketKey}, ${j.statusLabel.toLowerCase()}`).join('; ');
    return `${active.length === 1 ? 'Hay uno en marcha' : `Hay ${active.length} en marcha`}: ${items}.`;
  }

  private async statusReply(): Promise<VoiceReply> {
    const focus = await this.focus();
    const sentence = this.statusSentence(this.visibleJobs());
    const say = focus?.decision ? `${sentence} Pendiente: ${focus.decision.speech}` : sentence;
    return {
      say: toSpeech(say, 600),
      listen: Boolean(focus?.decision),
      ...(focus ? { job: focus.job } : {}),
      ...(focus?.decision ? { decision: focus.decision } : {}),
    };
  }

  /**
   * Buscador de ramas de la tablet, como el desplegable de Slack: filtra por
   * texto sobre todas las ramas del remoto (develop, main y release/* primero).
   */
  async searchBranches(query: string, limit = 50): Promise<{ branches: string[]; error?: string }> {
    let all: string[];
    try {
      all = await this.intake.listBranches();
    } catch (err) {
      return { branches: [], error: plain((err as Error).message) };
    }
    const q = query.trim().toLowerCase();
    return { branches: (q ? all.filter((b) => b.toLowerCase().includes(q)) : all).slice(0, limit) };
  }

  private async branches(): Promise<string[]> {
    try {
      return await Promise.race([this.intake.listBranches(), new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 4000))]);
    } catch {
      return [];
    }
  }

  voiceJob(job: JobDto | JobDetailDto): VoiceJob {
    const worktrees = 'worktrees' in job ? job.worktrees : (this.jobs.getDetail(job.id)?.worktrees ?? []);
    return {
      id: job.id,
      ticketKey: job.ticketKey,
      summary: job.ticketSummary,
      status: job.status,
      statusLabel: STATUS_LABELS[job.status],
      source: job.source,
      issue: job.issue,
      solution: job.solution,
      testsResult: job.testsResult,
      failureReason: job.failureReason,
      prUrls: worktrees.filter((w) => w.prUrl).map((w) => w.prUrl ?? ''),
      slackPermalink: job.slackPermalink,
      updatedAt: job.updatedAt,
    };
  }
}
