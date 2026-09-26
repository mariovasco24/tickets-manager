import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { messagesFromEvent } from './claude/messages.js';
import { parseOutcomeDetailed, type ClaudeOutcome } from './claude/outcome.js';
import {
  buildFollowUpPrompt,
  buildInitialPrompt,
  buildInvalidJsonPrompt,
  buildMissingJsonPrompt,
  buildRegressionPrompt,
  buildReposAddedPrompt,
  buildReposRejectedPrompt,
  buildResumePrompt,
  buildSystemPrompt,
  buildTriagePrompt,
  buildTriageSystemPrompt,
  type E2EContext,
  type FixWorktree,
  type PromptContext,
  type RegressionContext,
} from './claude/prompt.js';
import type { ClaudeRunner, RunOutcome, SessionAccess, StreamEvent } from './claude/runner.js';
import { E2E_DIR, collectArtifacts, e2eDirFor, linkNodeModules, readPhaseReport, verdict, writeManifest } from './e2e/artifacts.js';
import { evaluateRegression } from './e2e/regression.js';
import type { DevServerManager } from './e2e/devserver.js';
import { EnvironmentError } from './e2e/devserver.js';
import {
  checkEnvironment,
  explainEnvironments,
  harnessFileFor,
  harnessUrlFor,
  loadEnvironments,
  missingKeys,
  pickEnvironment,
  verifyHarness,
  writeHarness,
  type DataEnvironment,
} from './e2e/harness.js';
import { detectProject, detectServedRoot } from './e2e/project.js';
import { PublishError, commitHeader, commitsAhead, pushBranch, remoteUrl, stageAndCommit } from './git/publish.js';
import { WorktreeError, parsePorcelain, type WorktreeManager } from './git/worktree.js';
import { JiraClient, JiraError } from './jira/client.js';
import { buildFixComment, type CommentVideo, type PullRequestLink } from './jira/comment.js';
import { JobStateError, type JobService } from './jobs/service.js';
import { ticketLogger } from './logger.js';
import { RepoRegistryError, type RepoRegistry } from './repos/registry.js';
import { parseBitbucketRemote, type BitbucketClient } from './scm/bitbucket.js';
import { buildPullRequestDescription } from './scm/pr-description.js';
import { isTerminal, type AnswerVia, type JobDto, type JobPhase, type JobWorktreeDto,
  type RegressionInfo, type TriageResult } from './shared/job-types.js';
import type { SlackNotifier } from './slack/notifier.js';
import type { IncomingBug, JiraIssue, ThreadRef } from './types.js';
import { run } from './util/exec.js';

export interface IntakeOptions {
  maxClarificationRounds: number;
  /** Cada fix debe traer un spec del repo verificado rojo → verde (REGRESSION_SPEC_REQUIRED). */
  regressionRequired: boolean;
  /** URL base del dashboard para enlazar el detalle del job desde Slack. */
  dashboardUrl: string;
  /** Repo del manifest contra el que se listan las ramas del desplegable. Vacío = primero clonado. */
  branchesReferenceRepo: string | undefined;
  /** Reproducción en navegador activada. */
  e2eEnabled: boolean;
  /** Dónde se guardan vídeos, capturas y trazas (fuera de los worktrees). */
  artifactsDir: string;
  /** Ruta absoluta de bin/e2e-run.mjs. */
  wrapperPath: string;
  /** Ambiente de datos a usar (E2E_ENV). */
  defaultEnvironment: string | undefined;
  /** Archivo JSON con todos los ambientes de datos (E2E_ENVIRONMENTS_FILE), ya resuelto a ruta absoluta. */
  environmentsFile: string | undefined;
  /** Ofrecer mover el ticket a "en curso" en Jira al empezar (siempre se pregunta). */
  jiraAllowTransition: boolean;
  /** Nombre del estado destino en tu flujo de Jira. */
  jiraInProgressStatus: string;
  /** Ofrecer publicar el reporte del fix como comentario en el ticket. */
  jiraAllowComment: boolean;
  /** Estado de Jira que se ofrece tras abrir el PR (undefined = no se ofrece). */
  jiraWaitingForMergeStatus: string | undefined;
  /** Ofrecer subir la rama y abrir el PR hacia la rama origen. Nunca push directo ni merge. */
  prEnabled: boolean;
  prCloseSourceBranch: boolean;
  /** Plantilla del commit y del título del PR: {key}, {summary}. */
  commitTemplate: string;
  gitRemote: string;
  bitbucket: BitbucketClient | undefined;
  /** Workspace cuando el remoto no es una URL de bitbucket.org (el slug es el nombre del repo). */
  bitbucketWorkspace: string | undefined;
}

/**
 * Orquestador. Flujo: disparador → hilo → rama → TRIAJE en el repo de
 * conocimiento (qué repos tocan el bug) → confirmación → worktrees en cada repo
 * (misma rama) → FIX con una sesión de Claude Code que ve todos los worktrees →
 * aclaraciones / repos adicionales por el hilo → reporte. Compone JobService,
 * JiraClient, SlackNotifier, WorktreeManager, RepoRegistry y ClaudeRunner.
 */
export class Intake {
  /** Tickets ya leídos, para no volver a Jira al construir prompts. */
  private readonly issues = new Map<string, JiraIssue>();
  /** Mensajes del equipo llegados mientras Claude Code trabajaba; se entregan al terminar el turno. */
  private readonly queued = new Map<string, string[]>();

  constructor(
    private readonly jira: JiraClient,
    private readonly slack: SlackNotifier,
    private readonly jobs: JobService,
    private readonly worktrees: WorktreeManager,
    private readonly repos: RepoRegistry,
    private readonly claude: ClaudeRunner,
    private readonly devServers: DevServerManager,
    private readonly opts: IntakeOptions,
  ) {
    // Al terminar un job por la vía que sea (fix, cannot_fix, fallo, timeout, descarte) su servidor
    // de desarrollo se detiene. Antes los fallos por timeout o por contrato lo dejaban vivo. Si el
    // job se reanuda después, reviveE2E lo vuelve a levantar.
    this.jobs.on('job', (job) => {
      if (isTerminal(job.status)) this.devServers.stop(job.id);
    });
  }

  /** Ambientes de datos leídos del entorno del servicio (credenciales fuera de logs). */
  private environmentsCache: Map<string, DataEnvironment> | undefined;
  /** Jobs cuyo PR se está abriendo ahora mismo: evita el doble clic. */
  private readonly prInFlight = new Set<string>();
  /** Fixes completos que esperan la decisión humana "aceptar sin spec / descartar". */
  private readonly pendingFixed = new Map<string, { outcome: FixedOutcome; filesChanged: string[]; deniedNote: string | undefined; regression: RegressionInfo }>();
  /** Ambientes de datos (archivo + variables). Se cargan una vez, al primer uso. */
  private get environments(): Map<string, DataEnvironment> {
    this.environmentsCache ??= loadEnvironments(process.env, this.opts.environmentsFile);
    return this.environmentsCache;
  }

  // ---------------------------------------------------------------------------
  // Entrada
  // ---------------------------------------------------------------------------

  async receive(bug: IncomingBug): Promise<JobDto | undefined> {
    const log = ticketLogger(bug.key, { source: bug.source });

    const active = this.jobs.findActiveByTicket(bug.key);
    if (active) {
      log.warn({ job: active.id, status: active.status }, 'Ya existe un job activo; no se crea otro');
      const where = active.slackPermalink ? ` Sigue el <${active.slackPermalink}|hilo existente>.` : '';
      await this.slack.postToChannel(`:information_source: *${bug.key}* ya tiene un job activo (estado _${active.status}_).${where}`);
      return active;
    }

    let job = this.jobs.create(bug);

    let issue: JiraIssue;
    try {
      issue = await this.jira.getIssue(bug.key);
    } catch (err) {
      const reason = err instanceof JiraError ? err.message : 'error inesperado leyendo Jira';
      log.error({ err }, 'No se pudo leer el ticket en Jira');
      this.jobs.fail(job.id, reason);
      await this.slack.postToChannel(`:warning: No pude leer *${bug.key}* en Jira: ${reason}`);
      return this.jobs.get(job.id);
    }
    this.issues.set(job.id, issue);
    job = this.jobs.setTicket(job.id, issue);

    const thread = await this.slack.openThread(issue, bug);
    const permalink = await this.slack.permalink(thread).catch(() => undefined);
    job = this.jobs.attachThread(job.id, thread, permalink);

    if (JiraClient.isClosed(issue)) {
      await this.slack.reply(thread, `El ticket está en *${issue.status}*. No hago nada con él.`);
      return this.jobs.discard(job.id, `ticket en ${issue.status}`);
    }

    if (bug.sourceBranch) this.jobs.note(job.id, 'branch_given', `Rama origen indicada de antemano: ${bug.sourceBranch}`);

    // Antes de la rama: ¿movemos el ticket a "en curso" en Jira? Es la única escritura
    // que hace el servicio y nunca ocurre sin confirmación.
    if (await this.askJiraStatus(job.id, issue, thread)) return this.jobs.get(job.id);

    return this.proceedAfterJira(job.id, thread);
  }

  /** Rama origen (o triaje directo si ya venía indicada). Se llama al resolver lo de Jira. */
  private async proceedAfterJira(jobId: string, thread: ThreadRef): Promise<JobDto | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.sourceBranch) {
      if (await this.branchExists(job.sourceBranch)) {
        const updated = this.jobs.transition(jobId, 'triaging', `Rama origen: ${job.sourceBranch}. Analizando en qué repositorios está el bug…`);
        void this.runTriage(jobId);
        return updated;
      }
      await this.slack.reply(thread, `La rama \`${job.sourceBranch}\` no existe en el remoto. Elige otra:`);
    }
    return this.askBranch(jobId, thread);
  }

  /**
   * Ofrece mover el ticket al estado de trabajo en curso. Devuelve true si se ha
   * preguntado (el job queda esperando). No pregunta si ya está en ese estado, si
   * Jira no ofrece esa transición, o si está desactivado por configuración.
   */
  private async askJiraStatus(jobId: string, issue: JiraIssue, thread: ThreadRef): Promise<boolean> {
    if (!this.opts.jiraAllowTransition) return false;
    const target = this.opts.jiraInProgressStatus;
    const log = ticketLogger(issue.key, { job: jobId, component: 'jira' });
    if (issue.status.toLowerCase() === target.toLowerCase()) return false;

    let transitions: Array<{ id: string; name: string; to: string }>;
    try {
      transitions = await this.jira.getTransitions(issue.key);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'No se pudieron listar las transiciones; se sigue sin tocar Jira');
      return false;
    }
    if (!findTransition(transitions, target)) {
      log.info({ available: transitions.map((t) => t.to || t.name) }, `Jira no ofrece ahora una transición a "${target}"`);
      return false;
    }

    const question = `¿Muevo *${issue.key}* en Jira de "${issue.status}" a "${target}"?`;
    this.jobs.ask(jobId, 'awaiting_jira_status', question);
    await this.slack.askJiraStatus(thread, jobId, question);
    return true;
  }

  /** Respuesta a la pregunta del estado en Jira. Con "no", Jira no se toca. */
  async jiraDecision(jobId: string, accept: boolean, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (job.status !== 'awaiting_jira_status') throw new JobStateError(`El job ${job.ticketKey} no está esperando la decisión de Jira (${job.status})`);
    const thread = threadOf(job);
    const target = this.opts.jiraInProgressStatus;

    if (accept) {
      try {
        const match = findTransition(await this.jira.getTransitions(job.ticketKey), target);
        if (!match) throw new Error(`Jira ya no ofrece una transición a "${target}"`);
        await this.jira.transition(job.ticketKey, match.id);
        this.jobs.note(jobId, 'jira_transition', `Ticket movido a "${target}" en Jira (${who})`, { via, who });
        if (thread) await this.slack.reply(thread, `:arrows_counterclockwise: *${job.ticketKey}* movido a *${target}* en Jira (${who}).`);
      } catch (err) {
        this.jobs.note(jobId, 'jira_transition_failed', `No se pudo cambiar el estado en Jira: ${(err as Error).message}`);
        if (thread) await this.slack.reply(thread, `:warning: No pude cambiar el estado en Jira: ${(err as Error).message}. Sigo con el fix igualmente.`);
      }
    } else {
      this.jobs.note(jobId, 'jira_transition_skipped', `Sin cambios en Jira por decisión de ${who}`, { via, who });
      if (thread) await this.slack.reply(thread, `:ok_hand: Dejo el estado del ticket como está (${who}).`);
    }

    const updated = this.jobs.transition(jobId, 'received', accept ? 'Estado en Jira resuelto' : 'Estado en Jira sin cambios');
    if (thread) return (await this.proceedAfterJira(jobId, thread)) ?? updated;
    return updated;
  }

  /** Respuesta humana a un job en awaiting_*. */
  async answer(jobId: string, text: string, via: AnswerVia, who: string): Promise<JobDto> {
    const current = this.jobs.get(jobId);
    if (!current) throw new JobStateError(`Job ${jobId} no existe`);
    const thread = threadOf(current);
    const answer = text.trim();

    switch (current.status) {
      case 'awaiting_branch': {
        if (!(await this.branchExists(answer))) {
          if (thread) await this.slack.reply(thread, `:x: La rama \`${answer}\` no existe en el remoto. Elige una del desplegable o escribe otra.`);
          throw new JobStateError(`La rama "${answer}" no existe en el remoto`);
        }
        const { job } = this.jobs.answer(jobId, answer, via, who);
        if (thread) {
          const text = via === 'slack' ? `Rama origen: \`${answer}\`.` : `${viaIcon(via)} Rama origen elegida ${viaLabel(via)}: \`${answer}\`.`;
          await this.slack.reply(thread, `${text} :mag: Analizando en el catálogo de la plataforma en qué repositorios está el bug…`);
        }
        void this.runTriage(job.id);
        return job;
      }

      case 'awaiting_jira_status':
        return this.jiraDecision(jobId, !/^(no|nel|nop|deja|sin cambios|negativo)\b/i.test(answer), via, who);

      case 'awaiting_repos': {
        // "repos: a, b" → confirmar con esa lista; "ok|sí|confirmar" → confirmar la propuesta; "no|rechazar" → rechazar.
        const lower = answer.toLowerCase();
        if (/^(no|rechazar|rechazo|cancelar)\b/.test(lower)) return this.rejectRepos(jobId, via, who);
        if (/^(ok|sí|si|confirmar|confirmo|dale|adelante)\b/.test(lower)) return this.confirmRepos(jobId, undefined, via, who);
        const list = answer
          .replace(/^repos?\s*:/i, '')
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        return this.confirmRepos(jobId, list, via, who);
      }

      case 'awaiting_clarification': {
        // Si lo pendiente es la decisión de entorno, cualquier respuesta la resuelve.
        if (current.e2eMode === 'awaiting_env') {
          if (/^(no|descartar|descarta|cancelar|abortar)\b/i.test(answer)) return this.discard(jobId, 'sin entorno de reproducción', who);
          return this.continueWithoutEnv(jobId, via, who);
        }
        const { job } = this.jobs.answer(jobId, answer, via, who);
        if (thread) {
          const prefix = via === 'slack' ? `Respuesta de ${who} recibida` : `${viaIcon(via)} Respuesta ${viaLabel(via)}: ${answer}`;
          await this.slack.reply(thread, `${prefix}. Reanudando la sesión de ${job.phase === 'triage' ? 'triaje' : 'Claude Code'}…`);
        }
        void this.runSession(job.id, job.phase, 'resume', buildResumePrompt(answer));
        return job;
      }

      default:
        throw new JobStateError(`El job ${current.ticketKey} no está esperando respuesta (estado ${current.status})`);
    }
  }

  /** Mensaje humano dentro de un hilo de Slack: se interpreta según el estado del job. */
  async answerFromThread(channel: string, threadTs: string, text: string, userId: string): Promise<void> {
    const job = this.jobs.findByThread(channel, threadTs);
    if (!job) return;
    try {
      await this.humanMessage(job.id, text, 'slack', `<@${userId}>`);
    } catch (err) {
      if (!(err instanceof JobStateError)) throw err; // ya se avisó en el hilo
    }
  }

  /**
   * Cualquier mensaje del equipo hacia un job. El hilo funciona como el chat de
   * Claude Code: según el estado, responde una pregunta, se encola, reabre la
   * sesión o amplía las notas.
   */
  async humanMessage(jobId: string, text: string, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    const message = text.trim();
    if (!message) throw new JobStateError('El mensaje está vacío');
    const thread = threadOf(job);
    const log = ticketLogger(job.ticketKey, { job: jobId, via });
    const echo = via === 'slack' ? '' : `${viaIcon(via)} Mensaje ${viaLabel(via)}: ${message}\n`;

    switch (job.status) {
      case 'awaiting_jira_status':
      case 'awaiting_branch':
      case 'awaiting_repos':
      case 'awaiting_clarification':
        return this.answer(jobId, message, via, who);

      case 'triaging':
      case 'working': {
        const list = this.queued.get(jobId) ?? [];
        list.push(message);
        this.queued.set(jobId, list);
        this.jobs.note(jobId, 'message_queued', `Mensaje del equipo (${who}) en cola para el siguiente turno: ${message}`, { via, who });
        log.info('Mensaje encolado mientras Claude Code trabaja');
        if (thread) await this.slack.reply(thread, `${echo}:memo: Anotado. Se lo paso a Claude Code en cuanto termine el turno actual.`);
        return job;
      }

      case 'received':
      case 'creating_worktree': {
        const updated = this.jobs.appendNotes(jobId, message);
        if (thread) await this.slack.reply(thread, `${echo}:memo: Anotado como contexto para el primer prompt.`);
        return updated;
      }

      case 'fixed':
      case 'cannot_fix':
      case 'failed': {
        let reopened: JobDto;
        try {
          reopened = this.jobs.reopen(jobId, `mensaje de ${who}`);
        } catch (err) {
          if (thread && err instanceof JobStateError) await this.slack.reply(thread, `:information_source: ${err.message}.`);
          throw err;
        }
        this.jobs.note(jobId, 'message', `Mensaje del equipo (${who}): ${message}`, { via, who });
        if (thread) await this.slack.reply(thread, `${echo}:arrow_forward: Reanudando la sesión de Claude Code con tu mensaje…`);
        void this.runSession(jobId, 'fix', 'resume', buildFollowUpPrompt([message]));
        return reopened;
      }

      case 'discarded':
        if (thread) await this.slack.reply(thread, ':information_source: Este job está descartado. Pide `/fix` de nuevo para empezar otro.');
        throw new JobStateError(`El job ${job.ticketKey} está descartado`);
    }
  }

  async discard(jobId: string, reason: string | undefined, who: string): Promise<JobDto> {
    this.claude.kill(jobId, `descartado por ${who}`);
    this.devServers.stop(jobId);
    this.queued.delete(jobId);
    const job = this.jobs.discard(jobId, reason?.trim() || `descartado manualmente (${who})`);
    const thread = threadOf(job);
    if (thread) await this.slack.reply(thread, `:wastebasket: Job descartado (${who}). ${reason ?? ''}`.trim());
    return job;
  }

  // ---------------------------------------------------------------------------
  // Repositorios
  // ---------------------------------------------------------------------------

  listRepos(): Array<{ name: string; cloned: boolean; catalogProfile: boolean }> {
    return this.repos.names().map((n) => {
      const info = this.repos.get(n);
      return { name: n, cloned: info.cloned, catalogProfile: Boolean(info.catalogProfile) };
    });
  }

  /** Repos del job: worktrees vivos o, si aún no hay, la propuesta pendiente. */
  reposOf(jobId: string): string[] {
    const wts = this.jobs.activeWorktrees(jobId).map((w) => w.repoName);
    if (wts.length) return wts;
    return this.jobs.get(jobId)?.triageResult?.repos.map((r) => r.name) ?? [];
  }

  /**
   * Confirma los repos propuestos (o una lista distinta) para un job en
   * awaiting_repos: clona los que falten, crea los worktrees y arranca o
   * reanuda la sesión de fix.
   */
  async confirmRepos(jobId: string, list: string[] | undefined, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (job.status !== 'awaiting_repos') throw new JobStateError(`El job ${job.ticketKey} no está esperando confirmación de repos (${job.status})`);
    const thread = threadOf(job);

    const proposed = job.triageResult?.repos.map((r) => r.name) ?? [];
    const wanted = list?.length ? list : proposed;
    const resolved: string[] = [];
    const unknown: string[] = [];
    for (const name of wanted) {
      const canonical = this.repos.resolveName(name);
      if (canonical) {
        if (!resolved.includes(canonical)) resolved.push(canonical);
      } else unknown.push(name);
    }
    const already = new Set(this.jobs.activeWorktrees(jobId).map((w) => w.repoName));
    const toCreate = resolved.filter((r) => !already.has(r));

    if (unknown.length || toCreate.length === 0) {
      const msg = unknown.length
        ? `No reconozco estos repos en el manifest: ${unknown.join(', ')}.`
        : 'Todos esos repos ya tienen worktree en este job.';
      if (thread) await this.slack.reply(thread, `:x: ${msg} Escribe \`repos: nombre1, nombre2\` con nombres del manifest.`);
      throw new JobStateError(msg);
    }

    // Si la lista difiere de la propuesta, la registramos como decisión humana.
    if (list?.length) {
      this.jobs.setTriageResult(jobId, {
        repos: resolved.map((name) => ({ name, reason: `indicado por ${who}`, confidence: 'high' as const })),
        analysis: job.triageResult?.analysis ?? '',
      });
    }
    const { job: confirmed } = this.jobs.answer(jobId, `repos: ${resolved.join(', ')}`, via, who);
    if (thread && via !== 'slack') await this.slack.reply(thread, `${viaIcon(via)} Repositorios confirmados ${viaLabel(via)}: ${resolved.join(', ')}. Creando worktrees…`);

    void this.createWorktreesAndContinue(jobId, toCreate);
    return confirmed;
  }

  /** Rechaza la propuesta de repos. En triaje pide otros nombres; en fix reanuda a Claude sin ellos. */
  async rejectRepos(jobId: string, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (job.status !== 'awaiting_repos') throw new JobStateError(`El job ${job.ticketKey} no está esperando confirmación de repos (${job.status})`);
    const thread = threadOf(job);
    const rejected = job.triageResult?.repos.map((r) => r.name) ?? [];
    this.jobs.note(jobId, 'repos_rejected', `Propuesta de repos rechazada por ${who}: ${rejected.join(', ')}`, { via, who, rejected });

    if (job.phase === 'triage' || this.jobs.activeWorktrees(jobId).length === 0) {
      const question = `Propuesta rechazada. ¿En qué repositorios trabajo? Escribe "repos: nombre1, nombre2" (nombres del manifest) o descarta el job.`;
      const asked = this.jobs.ask(jobId, 'awaiting_repos', question);
      if (thread) await this.slack.reply(thread, `:leftwards_arrow_with_hook: ${question}`);
      return asked;
    }

    // Fase fix: Claude sigue con lo que tiene.
    const { job: resumed } = this.jobs.answer(jobId, `repos rechazados: ${rejected.join(', ')}`, via, who);
    const working = this.jobs.transition(resumed.id, 'working', 'Repos adicionales rechazados; Claude Code continúa con los worktrees actuales');
    if (thread) await this.slack.reply(thread, `:leftwards_arrow_with_hook: Repos rechazados. Claude Code continúa solo con ${this.reposOf(jobId).join(', ')}.`);
    void this.runSession(jobId, 'fix', 'resume', buildReposRejectedPrompt(rejected));
    return working;
  }

  async listBranches(): Promise<string[]> {
    return this.worktrees.listRemoteBranches(this.referenceRepoPath());
  }

  // ---------------------------------------------------------------------------
  // Worktrees
  // ---------------------------------------------------------------------------

  /** Elimina del disco todos los worktrees de un job terminado. */
  async removeWorktree(jobId: string, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (!isTerminal(job.status)) throw new JobStateError(`El job ${job.ticketKey} sigue activo (${job.status}); termínalo o descártalo antes`);
    const active = this.jobs.activeWorktrees(jobId);
    if (active.length === 0) {
      if (job.worktreePath && !job.worktreeRemovedAt) {
        // Compatibilidad con jobs anteriores a job_worktrees (un solo repo).
        await this.worktrees.remove(path.dirname(job.worktreePath), job.worktreePath, job.branch);
        return this.jobs.worktreeRemoved(jobId, who);
      }
      throw new JobStateError(`El job ${job.ticketKey} no tiene worktrees en disco`);
    }
    let updated = job;
    for (const wt of active) {
      await this.worktrees.remove(wt.repoPath, wt.worktreePath, wt.branch);
      updated = this.jobs.markWorktreeRemoved(jobId, wt, who);
    }
    const thread = threadOf(updated);
    if (thread) await this.slack.reply(thread, `:broom: Worktrees eliminados (${who}): ${active.map((w) => `\`${w.repoName}\``).join(', ')}.`);
    return updated;
  }

  async cleanupClosedWorktrees(who: string): Promise<{ removed: string[]; errors: Array<{ ticketKey: string; error: string }> }> {
    const removed: string[] = [];
    const errors: Array<{ ticketKey: string; error: string }> = [];
    for (const job of this.jobs.listTerminalWithWorktree()) {
      try {
        await this.removeWorktree(job.id, who);
        removed.push(job.ticketKey);
      } catch (err) {
        errors.push({ ticketKey: job.ticketKey, error: (err as Error).message });
      }
    }
    return { removed, errors };
  }

  /** Al arrancar: jobs con proceso en curso perdido por el reinicio → failed con la sesión anotada. */
  async recoverOrphans(): Promise<number> {
    let count = 0;
    for (const job of this.jobs.list()) {
      if (!['triaging', 'creating_worktree', 'working'].includes(job.status)) continue;
      count++;
      const session = job.phase === 'triage' ? job.triageSessionId : job.claudeSessionId;
      const reason = session
        ? `el servicio se reinició durante la sesión de ${job.phase === 'triage' ? 'triaje' : 'Claude Code'} (sesión ${session}${job.worktreePath ? `; retómala a mano con claude --resume en ${job.worktreePath}` : ''})`
        : 'el servicio se reinició mientras se preparaban los worktrees';
      this.jobs.fail(job.id, reason);
      const thread = threadOf(job);
      if (thread) await this.slack.reply(thread, `:warning: Job marcado como fallido: ${reason}.`).catch(() => undefined);
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Internos: rama
  // ---------------------------------------------------------------------------

  private referenceRepoPath(): string {
    const name = this.opts.branchesReferenceRepo ? this.repos.resolveName(this.opts.branchesReferenceRepo) : undefined;
    if (name) {
      const info = this.repos.get(name);
      if (info.cloned) return info.localPath;
    }
    const first = this.repos.cloned()[0];
    if (!first) throw new JobStateError('No hay ningún repo clonado en repos_product; clona al menos uno para listar ramas');
    return first.localPath;
  }

  private async branchExists(branch: string): Promise<boolean> {
    return this.worktrees.branchExistsOnRemote(this.referenceRepoPath(), branch);
  }

  private async askBranch(jobId: string, thread: ThreadRef): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    const question = `¿Desde qué rama origen creo los worktrees para ${job.ticketKey}?`;
    const asked = this.jobs.ask(jobId, 'awaiting_branch', question);
    let branchCount = 0;
    try {
      branchCount = (await this.listBranches()).length;
    } catch (err) {
      ticketLogger(job.ticketKey, { job: jobId }).warn({ err: (err as Error).message }, 'No se pudieron listar las ramas del remoto');
    }
    await this.slack.askBranch(thread, jobId, question, branchCount);
    return asked;
  }

  // ---------------------------------------------------------------------------
  // Internos: triaje
  // ---------------------------------------------------------------------------

  private async runTriage(jobId: string): Promise<void> {
    await this.runSession(jobId, 'triage', 'start');
  }

  /** Crea los worktrees pedidos y, según la fase, arranca la sesión de fix o reanuda la existente. */
  private async createWorktreesAndContinue(jobId: string, repoNames: string[]): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || !job.sourceBranch) return;
    const log = ticketLogger(job.ticketKey, { job: jobId });
    const thread = threadOf(job);

    const existing = this.jobs.activeWorktrees(jobId);
    const names = existing[0] ? { branch: existing[0].branch, jobDir: path.dirname(existing[0].worktreePath) } : this.worktrees.namesFor(job.ticketKey);
    const created: JobWorktreeDto[] = [];

    for (const repoName of repoNames) {
      try {
        const info = await this.repos.ensureCloned(repoName, (msg) => {
          if (thread) void this.slack.reply(thread, `:inbox_tray: ${msg}`);
        });
        const repoProblem = await this.worktrees.checkRepo(info.localPath);
        if (repoProblem) throw new WorktreeError(repoProblem, 'fetch');
        if (!(await this.worktrees.branchExistsOnRemote(info.localPath, job.sourceBranch))) {
          throw new WorktreeError(`La rama ${job.sourceBranch} no existe en el remoto de ${repoName}`, 'fetch');
        }
        const settings = this.repos.settingsFor(repoName);
        const result = await this.worktrees.create({
          repoName,
          repoPath: info.localPath,
          ticketKey: job.ticketKey,
          sourceBranch: job.sourceBranch,
          branch: names.branch,
          worktreePath: this.worktrees.worktreePathFor(names.jobDir, repoName),
          installCommand: settings.installCommand,
          copyFiles: settings.copyFiles,
        });
        const wt = this.jobs.addWorktree(jobId, {
          repoName,
          repoPath: info.localPath,
          worktreePath: result.worktreePath,
          branch: result.branch,
          isPrimary: existing.length === 0 && created.length === 0,
          installCommand: result.installCommand,
          baselineDirty: result.baselineDirty,
        });
        created.push(wt);
        if (thread) {
          const lines = [
            `:white_check_mark: Worktree *${repoName}* listo en \`${result.worktreePath}\``,
            `Rama \`${result.branch}\` desde \`${this.worktrees.remoteName}/${result.sourceBranch}\``,
            result.copied.length ? `Archivos copiados: ${result.copied.map((c) => `\`${c}\``).join(', ')}` : undefined,
            result.skippedCopies.length ? `:warning: Orígenes de COPY_FILES inexistentes (omitidos): ${result.skippedCopies.join(', ')}` : undefined,
            result.installCommand ? `Dependencias (\`${result.installCommand}\`) en ${Math.round(result.installDurationMs / 1000)}s.` : '_Sin instalación de dependencias (no hay package.json)._',
          ].filter(Boolean);
          await this.slack.reply(thread, lines.join('\n'));
        }
      } catch (err) {
        const step = err instanceof WorktreeError ? err.step : err instanceof RepoRegistryError ? 'clone' : 'unknown';
        const output = err instanceof WorktreeError ? err.output : undefined;
        log.error({ err: (err as Error).message, step, repo: repoName }, 'Fallo preparando el worktree');
        this.jobs.fail(jobId, `Worktree de ${repoName} (${step}): ${(err as Error).message}`);
        if (thread) {
          const tail = output ? `\n\`\`\`\n${output.split('\n').slice(-15).join('\n')}\n\`\`\`` : '';
          await this.slack.reply(thread, `:x: No pude preparar el worktree de *${repoName}* (${step}): ${(err as Error).message}${tail}`);
        }
        return;
      }
    }

    const after = this.jobs.get(jobId);
    if (!after || isTerminal(after.status)) return;

    if (after.phase === 'triage' || !after.claudeSessionId) {
      const env = await this.setupE2E(jobId);
      if (env.kind === 'asked') return; // esperando decisión humana sobre el entorno
      await this.runSession(jobId, 'fix', 'start', undefined, env.kind === 'ready' ? env.ctx : undefined);
    } else {
      const fixWts = created.map((w) => this.toFixWorktree(w));
      this.jobs.transition(jobId, 'working', `Worktrees añadidos: ${created.map((w) => w.repoName).join(', ')}. Reanudando Claude Code…`);
      await this.runSession(jobId, 'fix', 'resume', buildReposAddedPrompt(fixWts, []));
    }
  }

  // ---------------------------------------------------------------------------
  // Internos: entorno de reproducción (Playwright)
  // ---------------------------------------------------------------------------

  /**
   * Prepara lo necesario para reproducir el bug en un navegador: detecta si el
   * repo principal es una app con interfaz, levanta su dev server y genera la
   * página de embebido con los lanzadores LOCALES.
   *
   * - 'skip'  → no aplica (backend, sin comando, o E2E desactivado): fix normal.
   * - 'asked' → hace falta una decisión humana; ya se preguntó en el hilo.
   * - 'ready' → entorno listo, con el contexto para el prompt.
   */
  private async setupE2E(jobId: string): Promise<{ kind: 'ready'; ctx: E2EContext } | { kind: 'skip' } | { kind: 'asked' }> {
    const job = this.jobs.get(jobId);
    if (!job || !this.opts.e2eEnabled) return { kind: 'skip' };
    const primary = this.jobs.activeWorktrees(jobId).find((w) => w.isPrimary);
    if (!primary) return { kind: 'skip' };
    const log = ticketLogger(job.ticketKey, { job: jobId, component: 'e2e' });

    const project = detectProject(primary.worktreePath);
    const settings = this.repos.settingsFor(primary.repoName);
    const devCommand = settings.devCommand ?? project.devCommand;
    if (project.kind !== 'frontend' || !devCommand) {
      log.info({ kind: project.kind, devCommand }, 'Sin reproducción en navegador para este repo');
      return { kind: 'skip' };
    }

    // Ambiente de datos: solo se pregunta si falta o no responde.
    const env = pickEnvironment(this.environments, this.opts.defaultEnvironment);
    if (!env) {
      const names = [...this.environments.keys()];
      const preferred = this.opts.defaultEnvironment;
      // El detalle dice qué hay y qué falta (nunca valores): sin él, "no hay ambiente" no distingue
      // un archivo ausente de un domain que falta o de un nombre que no coincide.
      const detail = explainEnvironments(process.env, this.opts.environmentsFile);
      const reason = !names.length
        ? `no hay ningún ambiente de datos utilizable: ${detail}`
        : preferred
          ? `E2E_ENV=${preferred} no está entre los ambientes disponibles (${names.join(', ')}): ${detail}`
          : `no sé contra qué ambiente de datos montar el widget (hay ${names.join(', ')}; indica uno en E2E_ENV)`;
      log.warn({ environments: names, defaultEnvironment: preferred, detail }, 'Sin ambiente de datos para reproducir');
      await this.askEnvDecision(jobId, reason, undefined);
      return { kind: 'asked' };
    }
    const missing = missingKeys(env);
    if (missing.length) {
      await this.askEnvDecision(jobId, `al ambiente "${env.name}" le faltan claves: ${missing.join(', ')}`, undefined);
      return { kind: 'asked' };
    }
    const health = await checkEnvironment(env);
    if (!health.ok) {
      const others = [...this.environments.keys()].filter((n) => n !== env.name);
      const hint = others.length ? ` Otros ambientes disponibles: ${others.join(', ')} (cambia E2E_ENV en el .env y reinicia el servicio).` : '';
      await this.askEnvDecision(jobId, `el ambiente "${env.name}" (${env.domain}) no responde.${hint}`, health.detail);
      return { kind: 'asked' };
    }

    // Dev server del worktree. Nunca se reutiliza un puerto ajeno.
    let appUrl: string;
    try {
      const server = await this.devServers.start(jobId, primary.repoName, primary.worktreePath, devCommand);
      appUrl = server.url;
    } catch (err) {
      const occupant = err instanceof EnvironmentError ? err.occupant : undefined;
      const detail = err instanceof EnvironmentError ? err.output : undefined;
      log.warn({ err: (err as Error).message }, 'No se pudo levantar el entorno de reproducción');
      await this.askEnvDecision(
        jobId,
        `no pude levantar el entorno con \`${devCommand}\`: ${(err as Error).message}`,
        occupant ? `Puerto ${occupant.port} ocupado por PID ${occupant.pid} (${occupant.command}).` : detail,
      );
      return { kind: 'asked' };
    }

    const harnessDir = settings.harnessDir ?? project.harnessDir ?? 'src';
    const ctx = await this.prepareE2EContext(jobId, job, primary, appUrl, env, harnessDir, log);
    return { kind: 'ready', ctx };
  }

  /**
   * Con el servidor ya en marcha: enlaza node_modules, escribe (o re-apunta) el harness, lo
   * comprueba por HTTP, deja el manifiesto del wrapper y marca el job. Lo comparten el arranque
   * y la reanudación de un job cuyo servidor se había detenido.
   */
  private async prepareE2EContext(
    jobId: string,
    job: JobDto,
    primary: JobWorktreeDto,
    appUrl: string,
    env: DataEnvironment,
    harnessDir: string,
    log: ReturnType<typeof ticketLogger>,
    previousAppUrl?: string | null,
  ): Promise<E2EContext> {
    const e2eDir = e2eDirFor(this.opts.artifactsDir, jobId);
    await mkdir(e2eDir, { recursive: true });
    // node_modules del servicio a mano del agente desde el minuto uno (scripts de exploración con node).
    await linkNodeModules(e2eDir, path.dirname(path.dirname(this.opts.wrapperPath)));

    // El harness va al directorio que el servidor sirve tal cual (www/ en Stencil): se ve al instante
    // y sus ediciones no dependen de ninguna build. Sin directorio de salida, al directorio fuente.
    const servedRoot = detectServedRoot(primary.worktreePath);
    const target = { worktreePath: primary.worktreePath, harnessDir, servedRoot };
    let harnessFile = harnessFileFor(target);
    let servedDirectly = Boolean(servedRoot);
    if (previousAppUrl && existsSync(harnessFile)) {
      // Reanudación: el agente pudo haber editado el harness (tag, settings); solo se re-apuntan los
      // lanzadores si el puerto cambió, sin regenerar el archivo.
      if (previousAppUrl !== appUrl) {
        const html = await readFile(harnessFile, 'utf8');
        await writeFile(harnessFile, html.split(previousAppUrl).join(appUrl), 'utf8');
      }
    } else {
      const harness = await writeHarness({ ...target, appUrl, env, ticketKey: job.ticketKey });
      harnessFile = harness.file;
      servedDirectly = harness.servedDirectly;
    }
    const harnessUrl = harnessUrlFor({ appUrl, harnessDir });
    // Comprobado por HTTP ANTES de arrancar la sesión: si el agente tiene que descubrir por su cuenta
    // que la página no se sirve, pierde minutos (pasó en los dos jobs reales de AN-29011).
    const served = await verifyHarness(harnessUrl);
    if (!served.ok) log.warn({ url: harnessUrl, status: served.status, file: harnessFile }, 'El dev server no sirve el harness');

    // Manifiesto para el wrapper: URL, worktree y directorio servido, sin depender de flags ni del cwd.
    await writeManifest(e2eDir, {
      jobId,
      ticketKey: job.ticketKey,
      appUrl,
      worktree: primary.worktreePath,
      harnessFile,
      harnessUrl,
      servedRoot: servedRoot ? path.join(primary.worktreePath, servedRoot) : undefined,
      createdAt: new Date().toISOString(),
    });

    this.jobs.transition(
      jobId,
      job.status,
      `Entorno de reproducción listo en ${appUrl} (ambiente ${env.name}; harness ${served.ok ? 'servido' : `NO servido, HTTP ${served.status ?? 'sin respuesta'},`} en ${harnessUrl})`,
      { appUrl, e2eMode: 'e2e' },
    );

    return {
      appUrl,
      harnessFile,
      harnessUrl,
      harnessServed: served.ok,
      harnessServedDirectly: servedDirectly,
      e2eDir,
      wrapperPath: this.opts.wrapperPath,
      specPath: path.join(e2eDir, `${job.ticketKey}.spec.ts`),
      environment: env.name,
    };
  }

  /**
   * Al reanudar un job cuyo servidor de desarrollo ya no existe (se detiene al terminar el job y
   * la reanudación llega después), lo vuelve a levantar y actualiza harness y manifiesto: el
   * puerto puede cambiar. Devuelve una nota para el prompt, o undefined si no aplica.
   */
  private async reviveE2E(jobId: string): Promise<string | undefined> {
    const job = this.jobs.get(jobId);
    if (!job || job.e2eMode !== 'e2e' || !this.opts.e2eEnabled || this.devServers.get(jobId)) return undefined;
    const primary = this.jobs.activeWorktrees(jobId).find((w) => w.isPrimary);
    if (!primary) return undefined;
    const log = ticketLogger(job.ticketKey, { job: jobId, component: 'e2e' });
    const project = detectProject(primary.worktreePath);
    const settings = this.repos.settingsFor(primary.repoName);
    const devCommand = settings.devCommand ?? project.devCommand;
    const env = pickEnvironment(this.environments, this.opts.defaultEnvironment);
    if (!devCommand || !env) return undefined;
    try {
      const server = await this.devServers.start(jobId, primary.repoName, primary.worktreePath, devCommand);
      const ctx = await this.prepareE2EContext(jobId, job, primary, server.url, env, settings.harnessDir ?? project.harnessDir ?? 'src', log, job.appUrl);
      log.info({ appUrl: ctx.appUrl, previous: job.appUrl }, 'Entorno de reproducción levantado de nuevo para la reanudación');
      return `AVISO: el servidor de desarrollo se había detenido al cerrarse el job y lo he vuelto a levantar. Ahora está en ${ctx.appUrl} (puede ser otro puerto) y la página de embebido en ${ctx.harnessUrl}; el bugs-manager.json del directorio de la prueba ya apunta a la URL nueva, así que el wrapper funciona igual. Si algún script tuyo tenía la URL antigua escrita, actualízala.`;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'No se pudo levantar de nuevo el entorno de reproducción');
      return `AVISO: el servidor de desarrollo se había detenido y no he podido volver a levantarlo (${(err as Error).message}). Si necesitas ejecutar la prueba otra vez, dilo con needs_clarification; si no, continúa con el código.`;
    }
  }

  /** El equipo pide volver a intentar levantar el entorno (tras corregir la configuración o liberar el puerto). */
  async retryEnvironment(jobId: string, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (job.e2eMode !== 'awaiting_env') throw new JobStateError(`El job ${job.ticketKey} no está esperando decisión de entorno`);
    this.devServers.stop(jobId);
    this.environmentsCache = undefined; // environments.json se relee sin reiniciar el servicio
    const { job: answered } = this.jobs.answer(jobId, 'reintentar entorno', via, who);
    const thread = threadOf(answered);
    if (thread) await this.slack.reply(thread, `:repeat: Reintentando levantar el entorno de reproducción (${who})…`);
    const env = await this.setupE2E(jobId);
    if (env.kind === 'asked') return this.jobs.get(jobId) ?? answered;
    const working = this.jobs.transition(
      jobId,
      'working',
      env.kind === 'ready' ? 'Entorno de reproducción listo tras el reintento' : 'Sin reproducción en navegador para este repositorio',
      env.kind === 'ready' ? {} : { e2eMode: 'code_only' },
    );
    void this.runSession(jobId, 'fix', 'start', undefined, env.kind === 'ready' ? env.ctx : undefined);
    return working;
  }

  /** Pregunta en el hilo qué hacer cuando no hay entorno donde reproducir. */
  private async askEnvDecision(jobId: string, reason: string, detail: string | undefined): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const question = `No puedo reproducir el bug en un navegador: ${reason}. ¿Corrijo solo con código o descarto el job?`;
    this.jobs.transition(jobId, job.status, `Entorno de reproducción no disponible: ${reason}`, { e2eMode: 'awaiting_env' });
    this.jobs.ask(jobId, 'awaiting_clarification', question);
    const thread = threadOf(job);
    if (thread) await this.slack.askEnvDecision(thread, jobId, question, detail);
  }

  /** El equipo acepta arreglar sin reproducción en navegador. */
  async continueWithoutEnv(jobId: string, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (job.e2eMode !== 'awaiting_env') throw new JobStateError(`El job ${job.ticketKey} no está esperando decisión de entorno`);
    this.devServers.stop(jobId);
    const { job: updated } = this.jobs.answer(jobId, 'corregir solo con código', via, who);
    const working = this.jobs.transition(updated.id, 'working', `Sin reproducción en navegador por decisión de ${who}`, { e2eMode: 'code_only' });
    const thread = threadOf(working);
    if (thread) await this.slack.reply(thread, `:keyboard: Continúo solo con código (${who}). El fix se validará con los tests del repo.`);
    void this.runSession(jobId, 'fix', 'start');
    return working;
  }

  /**
   * Veredicto de la reproducción: lo decide el servicio leyendo los informes de
   * Playwright, no lo que diga el agente. Además recoge la evidencia.
   */
  private async evaluateReproduction(jobId: string, claimed: string | undefined): Promise<{ label: string; mismatch: boolean }> {
    const job = this.jobs.get(jobId);
    const primary = this.jobs.activeWorktrees(jobId).find((w) => w.isPrimary);
    if (!job || !primary) return { label: 'not applicable', mismatch: false };
    if (job.e2eMode === 'code_only') return { label: 'not run (fixed with code only, no environment)', mismatch: false };
    if (job.e2eMode !== 'e2e') return { label: 'not applicable', mismatch: false };

    const e2eDir = e2eDirFor(this.opts.artifactsDir, jobId);
    const before = readPhaseReport(e2eDir, 'before');
    const after = readPhaseReport(e2eDir, 'after');
    const v = verdict(before, after);
    const log = ticketLogger(job.ticketKey, { job: jobId, component: 'e2e' });
    log.info({ before: before.status, after: after.status, claimed, verified: v.verified }, 'Veredicto de reproducción');

    if (claimed === 'reproduced' && !v.verified) {
      this.jobs.note(jobId, 'verification_mismatch', `Claude reportó "reproduced" pero los informes dicen otra cosa: ${v.label}`, {
        before: before.status,
        after: after.status,
      });
    }

    try {
      const artifacts = await collectArtifacts(e2eDir, path.join(this.opts.artifactsDir, jobId), job.ticketKey);
      for (const art of artifacts) this.jobs.addArtifact(jobId, { phase: art.phase, kind: art.kind, path: art.path, mime: art.mime });
      if (artifacts.length) log.info({ count: artifacts.length }, 'Evidencia de la reproducción guardada');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'No se pudo recoger la evidencia');
    }

    const detail = before.firstError && v.verified ? ` — before failed with: ${before.firstError.split('\n')[0]}` : '';
    return { label: `${v.label}${detail}`, mismatch: v.mismatch };
  }

  /** Publica en el hilo los vídeos y capturas de antes y después del fix. */
  private async uploadEvidence(jobId: string, thread: ThreadRef): Promise<void> {
    const job = this.jobs.get(jobId);
    const artifacts = this.jobs.listArtifacts(jobId);
    if (!job || artifacts.length === 0) return;
    const log = ticketLogger(job.ticketKey, { job: jobId, component: 'e2e' });
    const videos = artifacts.filter((a) => a.kind === 'video');
    const shots = artifacts.filter((a) => a.kind === 'screenshot');
    // Los vídeos cuentan la historia; de las capturas basta una por fase.
    const chosen = [...videos, ...(videos.length ? [] : [shots.find((s) => s.phase === 'before'), shots.find((s) => s.phase === 'after')])].filter(
      (a): a is NonNullable<typeof a> => Boolean(a),
    );
    for (const art of chosen) {
      const file = this.jobs.artifactPath(jobId, art.id);
      if (!file) continue;
      const title = art.phase === 'before' ? `${job.ticketKey} — Before (bug)` : `${job.ticketKey} — After (fixed)`;
      try {
        await this.slack.uploadFile(thread, file, title);
      } catch (err) {
        log.warn({ err: (err as Error).message, file }, 'No se pudo subir la evidencia a Slack (¿falta el scope files:write?)');
        await this.slack
          .reply(thread, `:warning: No pude subir "${title}" a Slack (${(err as Error).message}). Está en el dashboard: ${this.jobLink(jobId)}`)
          .catch(() => undefined);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pull request: la rama se sube con su MISMO nombre y el PR queda abierto hacia la
  // rama origen. Regla dura: nunca se empuja a la rama origen ni se mergea.
  // ---------------------------------------------------------------------------

  private prDecided(jobId: string): boolean {
    const events = this.jobs.getDetail(jobId)?.events ?? [];
    return events.some((e) => e.type === 'pr_opened' || e.type === 'pr_skipped') || this.openPullRequests(jobId).length > 0;
  }

  private openPullRequests(jobId: string): PullRequestLink[] {
    return this.jobs
      .activeWorktrees(jobId)
      .filter((w) => w.prUrl)
      .map((w) => ({ repoName: w.repoName, url: w.prUrl ?? '', destination: w.prDestination ?? '' }));
  }

  /** Tras el fix, ofrece subir la rama y abrir el PR. Devuelve true si se preguntó. */
  private async offerPullRequest(jobId: string, thread: ThreadRef): Promise<boolean> {
    if (!this.opts.prEnabled || !this.opts.bitbucket) return false;
    const job = this.jobs.get(jobId);
    if (!job?.sourceBranch || this.prDecided(jobId)) return false;
    const repos = this.jobs.activeWorktrees(jobId).map((w) => w.repoName);
    if (!repos.length) return false;
    await this.slack.askPullRequest(thread, jobId, job.branch ?? '', job.sourceBranch, repos);
    return true;
  }

  /** Respuesta a la pregunta del PR. Con "no", nada se sube y se pasa al comentario. */
  async pullRequestDecision(jobId: string, accept: boolean, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (job.status !== 'fixed') throw new JobStateError(`El job ${job.ticketKey} no está en fixed (${job.status})`);
    if (!job.sourceBranch) throw new JobStateError(`El job ${job.ticketKey} no tiene rama origen`);
    const thread = threadOf(job);

    if (!accept) {
      if (this.prDecided(jobId)) throw new JobStateError(`El PR de ${job.ticketKey} ya se decidió`);
      this.jobs.note(jobId, 'pr_skipped', `Sin PR por decisión de ${who}`, { via, who });
      if (thread) {
        await this.slack.reply(thread, `:ok_hand: No subo la rama (${who}). Puedes hacerlo a mano desde el worktree.`);
        await this.offerJiraComment(jobId, thread);
      }
      return job;
    }

    if (this.openPullRequests(jobId).length) throw new JobStateError(`El PR de ${job.ticketKey} ya está abierto`);
    if (this.prInFlight.has(jobId)) throw new JobStateError(`Ya estoy subiendo la rama de ${job.ticketKey}`);
    const bitbucket = this.opts.bitbucket;
    if (!bitbucket) throw new JobStateError('Bitbucket no está configurado (PR_ENABLED / BITBUCKET_API_TOKEN)');

    this.prInFlight.add(jobId);
    try {
      const log = ticketLogger(job.ticketKey, { job: jobId, component: 'pr' });
      const results: string[] = [];
      let opened = 0;
      for (const wt of this.jobs.activeWorktrees(jobId)) {
        try {
          const r = await this.publishWorktree(job, wt, bitbucket, log);
          if (!r) {
            results.push(`• *${wt.repoName}*: sin cambios, no se sube`);
            continue;
          }
          opened += 1;
          results.push(`• *${wt.repoName}*: <${r.url}|PR #${r.id}> → \`${job.sourceBranch}\`${r.reused ? ' _(ya existía)_' : ''}${r.committed ? ` · commit \`${r.sha}\` (${r.files} archivo(s))` : ''}`);
        } catch (err) {
          const detail = err instanceof PublishError && err.output ? `\n\`\`\`\n${err.output}\n\`\`\`` : '';
          log.warn({ err: (err as Error).message, repo: wt.repoName }, 'No se pudo abrir el PR');
          this.jobs.note(jobId, 'pr_failed', `${wt.repoName}: ${(err as Error).message}`);
          results.push(`• *${wt.repoName}*: :x: ${(err as Error).message}${detail}`);
        }
      }
      if (opened) this.jobs.note(jobId, 'pr_opened', `${opened} pull request(s) abierto(s) hacia ${job.sourceBranch} (${who})`, { via, who });
      if (thread) {
        const head = opened ? `:rocket: Rama subida y PR abierto hacia \`${job.sourceBranch}\` (${who}):` : `:warning: No se abrió ningún PR (${who}):`;
        const foot = opened ? '\n_Nada se mergea automáticamente: el PR queda abierto para revisión._' : '';
        await this.slack.reply(thread, `${head}\n${results.join('\n')}${foot}`);
        if (!opened) {
          // Nada abierto (credenciales, red…): se vuelve a ofrecer para que, corregida la causa, baste un
          // clic. Lo que ya se commiteó o subió no se repite. El comentario espera a esta decisión.
          await this.slack.askPullRequest(thread, jobId, job.branch ?? '', job.sourceBranch, this.jobs.activeWorktrees(jobId).map((w) => w.repoName), true);
          return this.jobs.get(jobId) ?? job;
        }
        if (!(await this.offerJiraMergeStatus(jobId, thread))) await this.offerJiraComment(jobId, thread);
      }
      return this.jobs.get(jobId) ?? job;
    } finally {
      this.prInFlight.delete(jobId);
    }
  }

  /** Commit (si hay cambios), push de la rama con su nombre y PR en Bitbucket, para un worktree. */
  private async publishWorktree(
    job: JobDto,
    wt: JobWorktreeDto,
    bitbucket: BitbucketClient,
    log: ReturnType<typeof ticketLogger>,
  ): Promise<{ id: number; url: string; reused: boolean; committed: boolean; sha: string; files: number } | undefined> {
    const remote = this.opts.gitRemote;
    const sourceBranch = job.sourceBranch ?? '';
    const title = commitHeader(this.opts.commitTemplate, job.ticketKey, job.ticketSummary ?? '');

    const changes = await this.worktreeChanges(wt);
    let committed = false;
    let sha = '';
    if (changes.length) {
      ({ sha } = await stageAndCommit(wt.worktreePath, changes, title));
      committed = true;
      log.info({ repo: wt.repoName, files: changes.length, sha }, 'Cambios commiteados en el worktree');
    }
    // Sin commits por encima de la rama origen no hay nada que subir (ni cambios ni commits manuales).
    if (!(await commitsAhead(wt.worktreePath, remote, sourceBranch))) return undefined;

    await pushBranch(wt.worktreePath, remote, wt.branch);
    log.info({ repo: wt.repoName, branch: wt.branch }, 'Rama subida al remoto');

    const url = await remoteUrl(wt.worktreePath, remote);
    const repo = parseBitbucketRemote(url) ?? (this.opts.bitbucketWorkspace ? { workspace: this.opts.bitbucketWorkspace, slug: wt.repoName } : undefined);
    if (!repo) throw new PublishError(`el remoto ${remote} (${url}) no es de bitbucket.org y no hay BITBUCKET_WORKSPACE; la rama quedó subida`, 'inspect');

    const existing = await bitbucket.findOpenPullRequest(repo, wt.branch);
    const pr =
      existing ??
      (await bitbucket.createPullRequest(repo, {
        title,
        description: buildPullRequestDescription(job),
        sourceBranch: wt.branch,
        destinationBranch: sourceBranch,
        closeSourceBranch: this.opts.prCloseSourceBranch,
      }));
    this.jobs.setWorktreePullRequest(job.id, wt.id, { prUrl: pr.url, prId: pr.id, prDestination: sourceBranch, pushedAt: Date.now(), commitSha: sha || null });
    return { id: pr.id, url: pr.url, reused: Boolean(existing), committed, sha, files: changes.length };
  }

  // ---------------------------------------------------------------------------
  // Estado en Jira tras el PR (tercera escritura, siempre confirmada)
  // ---------------------------------------------------------------------------

  private jiraMergeDecided(jobId: string): boolean {
    return (this.jobs.getDetail(jobId)?.events ?? []).some((e) => e.type.startsWith('jira_merge_'));
  }

  /** Con el PR abierto, ofrece mover el ticket al estado de espera de merge. Devuelve true si se preguntó. */
  private async offerJiraMergeStatus(jobId: string, thread: ThreadRef): Promise<boolean> {
    const target = this.opts.jiraWaitingForMergeStatus;
    if (!target || !this.opts.jiraAllowTransition) return false;
    const job = this.jobs.get(jobId);
    if (!job || this.jiraMergeDecided(jobId)) return false;
    const log = ticketLogger(job.ticketKey, { job: jobId, component: 'jira' });
    let transitions: Awaited<ReturnType<JiraClient['getTransitions']>>;
    try {
      transitions = await this.jira.getTransitions(job.ticketKey);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'No pude listar las transiciones de Jira; no ofrezco el cambio de estado');
      return false;
    }
    if (!findTransition(transitions, target)) {
      log.info({ available: transitions.map((t) => t.to || t.name) }, `Jira no ofrece ahora una transición a "${target}"`);
      return false;
    }
    await this.slack.askJiraMerge(thread, jobId, `¿Muevo *${job.ticketKey}* en Jira a "${target}" ahora que el PR está abierto?`);
    return true;
  }

  /** Respuesta a la pregunta del estado tras el PR. Con "no", Jira no se toca. */
  async jiraMergeDecision(jobId: string, accept: boolean, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    const target = this.opts.jiraWaitingForMergeStatus;
    if (!target) throw new JobStateError('JIRA_WAITING_FOR_MERGE_STATUS no está configurado');
    if (this.jiraMergeDecided(jobId)) throw new JobStateError(`El estado de ${job.ticketKey} tras el PR ya se decidió`);
    const thread = threadOf(job);

    if (accept) {
      try {
        const match = findTransition(await this.jira.getTransitions(job.ticketKey), target);
        if (!match) throw new Error(`Jira ya no ofrece una transición a "${target}"`);
        await this.jira.transition(job.ticketKey, match.id);
        this.jobs.note(jobId, 'jira_merge_transition', `Ticket movido a "${target}" en Jira (${who})`, { via, who });
        if (thread) await this.slack.reply(thread, `:arrows_counterclockwise: *${job.ticketKey}* movido a *${target}* en Jira (${who}).`);
      } catch (err) {
        this.jobs.note(jobId, 'jira_merge_failed', `No se pudo cambiar el estado en Jira: ${(err as Error).message}`);
        if (thread) await this.slack.reply(thread, `:warning: No pude cambiar el estado en Jira: ${(err as Error).message}.`);
      }
    } else {
      this.jobs.note(jobId, 'jira_merge_skipped', `Estado en Jira sin cambios tras el PR por decisión de ${who}`, { via, who });
      if (thread) await this.slack.reply(thread, `:ok_hand: Dejo el estado del ticket como está (${who}).`);
    }
    if (thread) await this.offerJiraComment(jobId, thread);
    return this.jobs.get(jobId) ?? job;
  }

  /** ¿Ya se publicó el reporte en el ticket? Evita duplicados si se pulsa dos veces. */
  private alreadyCommented(jobId: string): boolean {
    return (this.jobs.getDetail(jobId)?.events ?? []).some((e) => e.type === 'jira_comment');
  }

  /** Tras el fix, ofrece publicar el reporte en el ticket. Nunca lo hace sin confirmación. */
  private async offerJiraComment(jobId: string, thread: ThreadRef): Promise<void> {
    if (!this.opts.jiraAllowComment) return;
    const job = this.jobs.get(jobId);
    if (!job || this.alreadyCommented(jobId)) return;
    const videos = this.jobs.listArtifacts(jobId).filter((a) => a.kind === 'video').length;
    await this.slack.askJiraComment(thread, jobId, job.ticketKey, videos);
  }

  /**
   * Publica el reporte del fix como comentario en el ticket, con los vídeos
   * adjuntos. Si Jira rechaza los medios incrustados, reintenta enlazándolos.
   */
  async publishJiraComment(jobId: string, accept: boolean, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    const thread = threadOf(job);

    if (!accept) {
      this.jobs.note(jobId, 'jira_comment_skipped', `Sin comentario en Jira por decisión de ${who}`, { via, who });
      if (thread) await this.slack.reply(thread, `:ok_hand: No publico nada en el ticket (${who}).`);
      return job;
    }
    if (this.alreadyCommented(jobId)) throw new JobStateError(`El reporte de ${job.ticketKey} ya se publicó en Jira`);
    if (!job.issue && !job.solution) throw new JobStateError(`El job ${job.ticketKey} todavía no tiene reporte que publicar`);

    const log = ticketLogger(job.ticketKey, { job: jobId, component: 'jira' });
    const videos: CommentVideo[] = [];
    for (const art of this.jobs.listArtifacts(jobId).filter((a) => a.kind === 'video')) {
      const file = this.jobs.artifactPath(jobId, art.id);
      if (!file) continue;
      try {
        const attached = await this.jira.addAttachment(job.ticketKey, file);
        videos.push({ phase: art.phase, attachmentId: attached.id, filename: attached.filename, url: attached.url });
      } catch (err) {
        log.warn({ err: (err as Error).message, phase: art.phase }, 'No se pudo adjuntar el vídeo al ticket');
      }
    }

    try {
      try {
        await this.jira.addComment(job.ticketKey, buildFixComment(job, videos, { embedVideos: true, pullRequests: this.openPullRequests(jobId) }));
      } catch (err) {
        // Algunos sitios rechazan los medios incrustados o las tarjetas: se publica con enlaces.
        log.warn({ err: (err as Error).message }, 'Comentario con vídeos incrustados rechazado; reintento con enlaces');
        await this.jira.addComment(job.ticketKey, buildFixComment(job, videos, { embedVideos: false, pullRequests: this.openPullRequests(jobId) }));
      }
    } catch (err) {
      this.jobs.note(jobId, 'jira_comment_failed', `No se pudo comentar en Jira: ${(err as Error).message}`);
      if (thread) await this.slack.reply(thread, `:warning: No pude publicar el reporte en ${job.ticketKey}: ${(err as Error).message}`);
      throw err;
    }

    this.jobs.note(jobId, 'jira_comment', `Reporte publicado en ${job.ticketKey} (${who}), ${videos.length} vídeo(s) adjunto(s)`, { via, who });
    if (thread) {
      await this.slack.reply(thread, `:memo: Reporte publicado en <${job.ticketUrl ?? ''}|${job.ticketKey}> con ${videos.length} vídeo(s) adjunto(s) (${who}).`);
    }
    return this.jobs.get(jobId) ?? job;
  }

  /** Para el dev server si el job ya terminó. */
  private stopEnvIfTerminal(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || isTerminal(job.status)) this.devServers.stop(jobId);
  }

  // ---------------------------------------------------------------------------
  // Internos: sesiones de Claude Code
  // ---------------------------------------------------------------------------

  /**
   * Ejecuta una sesión de Claude Code (triaje o fix; nueva o reanudada), vuelca
   * cada evento a la transcripción y decide el siguiente paso con el bloque JSON.
   */
  private async runSession(jobId: string, phase: JobPhase, mode: 'start' | 'resume', resumePrompt?: string, e2e?: E2EContext): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (this.claude.isRunning(jobId)) return;
    const log = ticketLogger(job.ticketKey, { job: jobId, phase });
    const thread = threadOf(job);

    let issue = this.issues.get(jobId);
    if (!issue && mode === 'start') {
      try {
        issue = await this.jira.getIssue(job.ticketKey);
        this.issues.set(jobId, issue);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'No se pudo releer el ticket en Jira; se usa lo guardado en el job');
        issue = issueFromJob(job);
      }
    }
    const ticket = issue ?? issueFromJob(job);

    // Dónde corre y a qué accede cada fase.
    let cwd: string;
    let access: SessionAccess;
    let systemPrompt = '';
    let initialPrompt = '';
    let sessionId = phase === 'triage' ? job.triageSessionId : job.claudeSessionId;

    if (phase === 'triage') {
      cwd = this.repos.knowledgePath;
      access = { readOnlyDirs: [this.repos.reposDir] };
      if (mode === 'start') {
        const ctx = {
          ticket,
          notes: job.notes ?? undefined,
          knowledgePath: this.repos.knowledgePath,
          reposDir: this.repos.reposDir,
          clonedRepos: this.repos.cloned().map((r) => r.name),
          allRepos: this.repos.names(),
        };
        systemPrompt = buildTriageSystemPrompt(ctx);
        initialPrompt = buildTriagePrompt(ctx);
      }
    } else {
      const wts = this.jobs.activeWorktrees(jobId);
      const primary = wts.find((w) => w.isPrimary) ?? wts[0];
      if (!primary) {
        this.jobs.fail(jobId, 'No hay worktrees para la sesión de fix');
        return;
      }
      cwd = primary.worktreePath;
      access = {
        // El andamiaje de la prueba vive fuera del repo para no ensuciarlo ni confundir a su
        // runner de tests; el directorio del wrapper se abre en solo lectura.
        writableDirs: [...wts.filter((w) => w.id !== primary.id).map((w) => w.worktreePath), e2eDirFor(this.opts.artifactsDir, jobId)],
        readOnlyDirs: [this.repos.knowledgePath, path.dirname(this.opts.wrapperPath)],
      };
      // El wrapper del spec y el de Playwright escriben aquí; existe siempre, haya o no entorno de navegador.
      await mkdir(e2eDirFor(this.opts.artifactsDir, jobId), { recursive: true });
      if (mode === 'resume') {
        const revived = await this.reviveE2E(jobId);
        if (revived) resumePrompt = `${revived}\n\n${resumePrompt ?? ''}`.trim();
      }
      if (mode === 'start') {
        const ctx = this.fixContext(job, ticket, wts, e2e);
        systemPrompt = buildSystemPrompt(ctx);
        initialPrompt = buildInitialPrompt(ctx);
      }
    }

    const denied: string[] = [];
    const onEvent = (ev: StreamEvent) => {
      for (const m of messagesFromEvent(ev)) {
        this.jobs.addMessage(jobId, m);
        if (m.kind === 'tool_result') {
          const byName = /requested permissions to use (\w+)/i.exec(m.summary);
          if (byName) denied.push(byName[1] ?? 'tool');
          else if (/requires? approval|was blocked/i.test(m.summary)) denied.push('Bash');
        }
      }
    };
    // Una o dos denegaciones de Bash (tuberías con tramos no permitidos) son normales y Claude
    // las rodea; solo se avisa si se denegó edición o si Bash se bloqueó repetidamente.
    const deniedSummary = () => {
      if (!denied.length) return undefined;
      const nonBash = denied.filter((d) => d !== 'Bash').length;
      const bash = denied.length - nonBash;
      if (nonBash === 0 && bash < 3) return undefined;
      const byTool = [...new Set(denied)].map((t) => `${t}×${denied.filter((d) => d === t).length}`).join(', ');
      return `Claude Code pidió permisos que nadie pudo conceder (${byTool}). Revisa CLAUDE_PERMISSION_MODE / CLAUDE_ALLOWED_TOOLS / CLAUDE_SETTING_SOURCES.`;
    };

    let outcome: RunOutcome;
    try {
      if (mode === 'start') {
        const handle = this.claude.start(jobId, cwd, initialPrompt, systemPrompt, onEvent, access);
        sessionId = handle.sessionId;
        this.jobs.setSession(jobId, handle.sessionId, phase);
        this.jobs.transition(jobId, phase === 'triage' ? 'triaging' : 'working', phase === 'triage' ? 'Triaje en el repo de conocimiento' : 'Claude Code trabajando en los worktrees');
        this.jobs.addMessage(jobId, {
          kind: 'user_prompt',
          toolName: null,
          summary: phase === 'triage' ? `Triaje de ${job.ticketKey} en el catálogo` : `Ticket ${job.ticketKey} enviado a Claude Code`,
          content: initialPrompt,
        });
        if (thread) {
          const what = phase === 'triage' ? ':mag: Triaje iniciado en el repo de conocimiento' : `:robot_face: Claude Code iniciado sobre ${this.reposOf(jobId).join(', ')}`;
          await this.slack.reply(thread, `${what} (sesión \`${handle.sessionId.slice(0, 8)}…\`). Sigue la sesión en vivo: ${this.jobLink(jobId)}`);
        }
        outcome = await handle.done;
      } else {
        if (!sessionId) throw new Error(`el job no tiene sesión de ${phase} que reanudar`);
        this.jobs.addMessage(jobId, { kind: 'user_prompt', toolName: null, summary: 'Mensaje del equipo enviado a Claude Code', content: resumePrompt });
        const handle = this.claude.resume(jobId, cwd, sessionId, resumePrompt ?? '', onEvent, access);
        outcome = await handle.done;
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'No se pudo lanzar Claude Code');
      this.jobs.fail(jobId, `No se pudo lanzar Claude Code: ${(err as Error).message}`);
      if (thread) await this.slack.reply(thread, `:x: No pude lanzar Claude Code: ${(err as Error).message}`);
      return;
    }

    this.jobs.recordUsage(jobId, outcome.costUsd, outcome.numTurns);

    const after = this.jobs.get(jobId);
    if (!after || isTerminal(after.status)) return; // descartado mientras corría

    if (outcome.isError) {
      const reason = outcome.timedOut
        ? `Claude Code superó el tiempo máximo (${outcome.errorReason})`
        : `Claude Code terminó con error: ${outcome.errorReason ?? 'desconocido'}${outcome.stderrTail ? `\n${outcome.stderrTail.split('\n').slice(-5).join('\n')}` : ''}`;
      this.jobs.fail(jobId, reason);
      if (thread) await this.slack.reply(thread, `:x: ${reason}${after.worktreePath ? `\nWorktrees conservados en \`${path.dirname(after.worktreePath)}\` para revisión manual.` : ''}`);
      return;
    }

    let verdict = parseOutcomeDetailed(outcome.resultText);
    if (verdict.kind !== 'ok') {
      // Sin bloque → se pide. Bloque inválido → se le dice exactamente qué corregir: antes se le
      // decía "no trajiste el bloque" cuando sí lo traía (p. ej. tests:"e2e") y repetía el mismo JSON.
      const invalid = verdict.kind === 'invalid' ? verdict.issues : undefined;
      const retryPrompt = invalid ? buildInvalidJsonPrompt(invalid) : buildMissingJsonPrompt();
      const why = invalid ? `El bloque JSON no cumple el contrato (${invalid.join('; ')})` : 'La respuesta no traía el bloque JSON del contrato';
      log.warn({ kind: verdict.kind, issues: invalid }, 'Contrato no cumplido; se pide de nuevo');
      this.jobs.note(jobId, invalid ? 'claude_invalid_json' : 'claude_no_json', `${why}; se le pide una vez más`, invalid ? { issues: invalid } : undefined);
      this.jobs.addMessage(jobId, { kind: 'user_prompt', toolName: null, summary: 'Reintento automático: el bloque JSON del contrato falta o no es válido', content: retryPrompt });
      const retry = this.claude.resume(jobId, cwd, outcome.sessionId, retryPrompt, onEvent, access);
      const retryOutcome = await retry.done;
      this.jobs.recordUsage(jobId, retryOutcome.costUsd, retryOutcome.numTurns);
      verdict = retryOutcome.isError ? { kind: 'no_block' } : parseOutcomeDetailed(retryOutcome.resultText);
      if (verdict.kind !== 'ok') {
        const reason =
          verdict.kind === 'invalid'
            ? `El bloque JSON de Claude Code no cumple el contrato: ${verdict.issues.join('; ')}`
            : 'Claude Code no devolvió el bloque JSON del contrato';
        this.jobs.fail(jobId, reason);
        if (thread) await this.slack.reply(thread, `:x: ${reason}. Revisa la sesión: ${this.jobLink(jobId)}`);
        return;
      }
    }
    const parsed = verdict.outcome;

    const deniedNote = deniedSummary();
    if (deniedNote) this.jobs.note(jobId, 'permissions_denied', deniedNote, { denied });
    await this.applyOutcome(jobId, phase, parsed, deniedNote);
    this.stopEnvIfTerminal(jobId);
    await this.deliverQueued(jobId);
  }

  private async applyOutcome(jobId: string, phase: JobPhase, outcome: ClaudeOutcome, deniedNote?: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const thread = threadOf(job);

    switch (outcome.status) {
      case 'needs_clarification': {
        const rounds = this.jobs.bumpClarificationRounds(jobId).clarificationRounds;
        if (rounds > this.opts.maxClarificationRounds) {
          const reason = `Claude Code pidió aclaraciones ${rounds} veces (máximo ${this.opts.maxClarificationRounds})`;
          this.jobs.transition(jobId, 'cannot_fix', reason, { failureReason: reason });
          if (thread) await this.slack.reply(thread, `:no_entry: ${reason}. Últimas preguntas:\n${numbered(outcome.questions)}`);
          return;
        }
        const question = outcome.questions.length === 1 ? outcome.questions[0]! : numbered(outcome.questions);
        this.jobs.ask(jobId, 'awaiting_clarification', question);
        if (thread) {
          await this.slack.reply(
            thread,
            `:question: ${phase === 'triage' ? 'El triaje' : 'Claude Code'} necesita aclarar (ronda ${rounds}/${this.opts.maxClarificationRounds}):\n${numbered(outcome.questions)}\n_Responde en este hilo o desde el dashboard; la sesión continuará donde se quedó._`,
          );
        }
        return;
      }

      case 'repos':
      case 'needs_repos': {
        // Propuesta de repos (triaje) o petición a mitad del fix. Ambas pasan por confirmación humana.
        const proposal: TriageResult =
          outcome.status === 'repos'
            ? { repos: outcome.repos, analysis: outcome.analysis }
            : { repos: outcome.repos.map((name) => ({ name, reason: outcome.reason, confidence: 'medium' as const })), analysis: outcome.reason };
        const already = new Set(this.jobs.activeWorktrees(jobId).map((w) => w.repoName));
        const valid: TriageResult['repos'] = [];
        const unknown: string[] = [];
        for (const r of proposal.repos) {
          const canonical = this.repos.resolveName(r.name);
          if (!canonical) unknown.push(r.name);
          else if (!already.has(canonical) && !valid.some((v) => v.name === canonical)) valid.push({ ...r, name: canonical });
        }
        if (valid.length === 0) {
          const reason = unknown.length
            ? `Claude propuso repos que no están en el manifest: ${unknown.join(', ')}`
            : 'Claude pidió repos que ya están en el job';
          if (phase === 'fix' && job.claudeSessionId) {
            this.jobs.note(jobId, 'repos_invalid', reason);
            await this.runSession(jobId, 'fix', 'resume', buildReposRejectedPrompt(proposal.repos.map((r) => r.name)));
            return;
          }
          this.jobs.transition(jobId, 'cannot_fix', reason, { failureReason: reason });
          if (thread) await this.slack.reply(thread, `:no_entry: ${reason}.`);
          return;
        }
        // El triaje fija la lista; needs_repos la amplía conservando los repos ya decididos.
        const previous = outcome.status === 'needs_repos' ? (job.triageResult?.repos ?? []).filter((r) => !valid.some((v) => v.name === r.name)) : [];
        this.jobs.setTriageResult(jobId, {
          repos: [...previous, ...valid],
          analysis: outcome.status === 'needs_repos' && job.triageResult?.analysis ? `${job.triageResult.analysis}\n\nRepos adicionales: ${proposal.analysis}` : proposal.analysis,
        });
        const title =
          outcome.status === 'repos'
            ? `El triaje propone trabajar en ${valid.length === 1 ? 'este repositorio' : 'estos repositorios'}:`
            : `Claude Code necesita ${valid.length === 1 ? 'otro repositorio' : 'otros repositorios'} para completar el fix:`;
        const question = `${title} ${valid.map((r) => r.name).join(', ')}. Confirma, cambia la lista ("repos: a, b") o rechaza.`;
        this.jobs.ask(jobId, 'awaiting_repos', question);
        if (thread) {
          await this.slack.askRepos(
            thread,
            jobId,
            title,
            valid.map((r) => ({ ...r, cloned: this.repos.get(r.name).cloned })),
            unknown.length ? `${proposal.analysis}\n(No reconocidos y omitidos: ${unknown.join(', ')})` : proposal.analysis,
          );
        }
        return;
      }

      case 'fixed': {
        if (phase === 'triage') {
          const reason = 'El triaje reportó "fixed" sin haber creado worktrees; no es un resultado válido';
          this.jobs.fail(jobId, reason);
          if (thread) await this.slack.reply(thread, `:x: ${reason}.`);
          return;
        }
        const filesChanged = await this.detectChangedFiles(jobId, outcome.files_changed);
        if (filesChanged.length === 0) {
          const reason = `Claude Code reportó "fixed" pero los worktrees no tienen cambios.${deniedNote ? ` ${deniedNote}` : ''}`;
          this.jobs.fail(jobId, reason);
          if (thread) {
            await this.slack.reply(thread, `:x: ${reason}\n*Lo que quería hacer:* ${outcome.solution || outcome.summary || outcome.issue || '(sin resumen)'}\nSesión: ${this.jobLink(jobId)}`);
          }
          return;
        }
        // Spec de regresión: el fix no se da por bueno sin un spec del repo verificado rojo → verde.
        const regression = evaluateRegression(e2eDirFor(this.opts.artifactsDir, jobId), outcome.regression_test, filesChanged);
        if (this.opts.regressionRequired && regression.verdict !== 'verified') {
          const alreadyAsked = (this.jobs.getDetail(jobId)?.events ?? []).some((e) => e.type === 'regression_requested');
          const wts = this.jobs.activeWorktrees(jobId);
          const primary = wts.find((w) => w.isPrimary) ?? wts[0];
          if (!alreadyAsked && primary) {
            // Primera vez: se le pide a Claude con el veredicto exacto y se reanuda la sesión.
            this.jobs.note(jobId, 'regression_requested', `Fix sin spec de regresión verificado (${regression.label}); se le pide a Claude Code`, { verdict: regression.verdict });
            if (thread) await this.slack.reply(thread, `:test_tube: El fix no tiene un spec de regresión verificado (${regression.label}). Se lo pido a Claude Code antes de dar el bug por solucionado.`);
            void this.runSession(jobId, 'fix', 'resume', buildRegressionPrompt(regression.label, this.regressionContext(job, wts), this.toFixWorktree(primary)));
            return;
          }
          // Segunda vez: decide una persona. El fix queda guardado para aplicarlo si lo acepta.
          const pending: RegressionInfo = { ...regression, verdict: 'pending' };
          this.pendingFixed.set(jobId, { outcome, filesChanged, deniedNote, regression });
          const question = `Claude Code no consiguió cubrir el fix de *${job.ticketKey}* con un spec de regresión: ${regression.label}. ¿Acepto el fix sin spec o descarto el job?`;
          this.jobs.note(jobId, 'regression_pending', `Sin spec de regresión tras pedirlo (${regression.label}); esperando decisión humana`, { verdict: regression.verdict });
          this.jobs.transition(jobId, job.status, 'Fix listo pero sin spec de regresión verificado', { regressionTest: pending });
          this.jobs.ask(jobId, 'awaiting_clarification', question);
          if (thread) await this.slack.askRegressionDecision(thread, jobId, question, regression.reason);
          return;
        }
        await this.finalizeFixed(jobId, outcome, filesChanged, deniedNote, regression);
        return;
      }

      case 'cannot_fix': {
        this.jobs.transition(jobId, 'cannot_fix', `Claude Code no pudo resolverlo: ${outcome.reason}`, { failureReason: outcome.reason });
        if (thread) await this.slack.reply(thread, `:no_entry: ${phase === 'triage' ? 'El triaje concluye que no es arreglable aquí' : `Claude Code no pudo resolver *${job.ticketKey}*`}: ${outcome.reason}`);
        return;
      }
    }
  }

  /**
   * Cierre de un fix aceptado: plantilla QA, veredicto de la reproducción, estado fixed, reporte
   * en Slack, evidencia, y el arranque del cierre (PR → estado en Jira → comentario).
   */
  private async finalizeFixed(jobId: string, outcome: FixedOutcome, filesChanged: string[], deniedNote: string | undefined, regression: RegressionInfo): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const thread = threadOf(job);
    // Plantilla QA (en inglés). Si Claude no rellenó issue/solution, se recuperan del summary libre.
    const issue = outcome.issue.trim() || outcome.summary.trim() || '(not provided)';
    const solution = outcome.solution.trim() || (outcome.issue.trim() ? '(not provided)' : '');
    const notesForQa = outcome.notes_for_qa?.trim() || null;
    const repro = await this.evaluateReproduction(jobId, outcome.reproduction);
    this.jobs.transition(jobId, 'fixed', `Fix reportado por Claude Code (tests: ${outcome.tests}; spec: ${regression.verdict})`, {
      reproduction: repro.label,
      filesChanged,
      testsResult: outcome.tests,
      testsDetail: outcome.tests_detail ?? null,
      regressionTest: regression,
      fixSummary: outcome.summary.trim() || `${issue}\n\n${solution}`.trim(),
      issue,
      solution: solution || null,
      notesForQa,
    });
    if (thread) {
      const wts = this.jobs.activeWorktrees(jobId);
      const touched = new Set(filesChanged.map((f) => f.split('/')[0]));
      const tests = outcome.tests === 'passed' ? ':white_check_mark: passed' : outcome.tests === 'failed' ? ':x: failed' : 'none';
      const perRepo = wts
        .map((w) => `• ${w.repoName}${touched.has(w.repoName) ? '' : ' _(no changes)_'}: \`${w.worktreePath}\``)
        .join('\n');
      await this.slack.reply(
        thread,
        [
          `:tada: *${job.ticketKey} fixed*`,
          '',
          `*Issue:*\n${issue}`,
          '',
          `*Solution:*\n${solution || '(not provided)'}`,
          notesForQa ? `\n*Notes for QA:*\n${notesForQa}` : undefined,
          '',
          `*Branch:* \`${job.branch}\``,
          `*Worktrees:*\n${perRepo}`,
          `*Files (${filesChanged.length}):* ${filesChanged.map((f) => `\`${f}\``).join(', ')}`,
          `*Tests:* ${tests}${outcome.tests_detail ? ` — ${outcome.tests_detail}` : ''}`,
          `*Regression test:* ${regression.verdict === 'verified' ? ':white_check_mark: ' : ':warning: '}${regression.label}`,
          `*Reproduction:* ${repro.mismatch ? ':warning: ' : ''}${repro.label}`,
          deniedNote ? `:warning: ${deniedNote}` : undefined,
          `_Nothing has been committed yet: review the diff in each worktree. Details: ${this.jobLink(jobId)}_`,
        ]
          .filter((l) => l !== undefined)
          .join('\n'),
      );
      await this.uploadEvidence(jobId, thread);
      // Orden del cierre: PR → (estado en Jira) → comentario con el enlace del PR.
      if (!(await this.offerPullRequest(jobId, thread))) await this.offerJiraComment(jobId, thread);
    }
    this.stopEnvIfTerminal(jobId);
  }

  /** Decisión humana sobre un fix sin spec: aceptarlo tal cual o descartar el job. */
  async regressionDecision(jobId: string, accept: boolean, via: AnswerVia, who: string): Promise<JobDto> {
    const job = this.jobs.get(jobId);
    if (!job) throw new JobStateError(`Job ${jobId} no existe`);
    if (job.regressionTest?.verdict !== 'pending') throw new JobStateError(`El job ${job.ticketKey} no está esperando la decisión sobre el spec de regresión`);
    if (!accept) {
      this.pendingFixed.delete(jobId);
      this.jobs.note(jobId, 'regression_discarded', `Job descartado por falta de spec de regresión (${who})`, { via, who });
      return this.discard(jobId, 'sin spec de regresión', who);
    }
    const pending = this.pendingFixed.get(jobId);
    if (!pending) {
      throw new JobStateError(`El resultado del fix de ${job.ticketKey} ya no está en memoria (el servicio se reinició): escribe en el hilo para que Claude Code vuelva a reportarlo`);
    }
    this.pendingFixed.delete(jobId);
    this.jobs.answer(jobId, 'aceptar el fix sin spec de regresión', via, who);
    this.jobs.note(jobId, 'regression_accepted', `Fix aceptado sin spec de regresión (${who})`, { via, who });
    const thread = threadOf(job);
    if (thread) await this.slack.reply(thread, `:test_tube: Fix aceptado sin spec de regresión (${who}). Quedará marcado así en el reporte.`);
    const accepted: RegressionInfo = { ...pending.regression, verdict: 'accepted', acceptedBy: who, label: `none — accepted without a regression spec by ${who}${pending.regression.reason ? ` (${pending.regression.reason})` : ''}` };
    await this.finalizeFixed(jobId, pending.outcome, pending.filesChanged, pending.deniedNote, accepted);
    return this.jobs.get(jobId) ?? job;
  }

  /** Entrega los mensajes que el equipo escribió mientras Claude Code trabajaba. */
  private async deliverQueued(jobId: string): Promise<void> {
    const queued = this.queued.get(jobId);
    if (!queued?.length) return;
    this.queued.delete(jobId);
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'discarded') return;
    const thread = threadOf(job);
    const log = ticketLogger(job.ticketKey, { job: jobId });
    log.info({ count: queued.length }, 'Entregando mensajes encolados a Claude Code');

    if (job.status === 'awaiting_clarification') {
      const { job: resumed } = this.jobs.answer(jobId, queued.join('\n'), 'slack', 'equipo (mensajes encolados)');
      if (thread) await this.slack.reply(thread, `:arrow_forward: Paso a Claude Code los ${queued.length} mensaje(s) que escribiste mientras trabajaba.`);
      void this.runSession(resumed.id, resumed.phase, 'resume', buildFollowUpPrompt(queued, job.pendingQuestion ?? undefined));
      return;
    }
    if (job.status === 'awaiting_repos') {
      // Se conservan como notas: la confirmación de repos sigue siendo del humano.
      for (const m of queued) this.jobs.appendNotes(jobId, m);
      if (thread) await this.slack.reply(thread, `:memo: Guardé tus ${queued.length} mensaje(s) como notas; confirma los repos para continuar.`);
      return;
    }
    if (job.status === 'fixed' || job.status === 'cannot_fix' || job.status === 'failed') {
      try {
        this.jobs.reopen(jobId, `${queued.length} mensaje(s) encolado(s) del equipo`);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'No se pudo reabrir para entregar los mensajes encolados');
        return;
      }
      if (thread) await this.slack.reply(thread, `:arrow_forward: Reanudando con los ${queued.length} mensaje(s) que escribiste mientras trabajaba.`);
      void this.runSession(jobId, 'fix', 'resume', buildFollowUpPrompt(queued));
    }
  }

  // ---------------------------------------------------------------------------
  // Internos: utilidades
  // ---------------------------------------------------------------------------

  private fixContext(job: JobDto, ticket: JiraIssue, wts: JobWorktreeDto[], e2e?: E2EContext): PromptContext {
    const present = new Set(wts.map((w) => w.repoName));
    return {
      ticket,
      branch: wts[0]?.branch ?? job.branch ?? '',
      sourceBranch: job.sourceBranch ?? '',
      worktrees: wts.map((w) => this.toFixWorktree(w)),
      knowledgePath: this.repos.knowledgePath,
      availableRepos: this.repos.names().filter((n) => !present.has(n)),
      triageAnalysis: job.triageResult?.analysis || undefined,
      notes: job.notes ?? undefined,
      e2e,
      regression: this.regressionContext(job, wts),
    };
  }

  /** Wrapper, directorio de registros y frameworks de test del repo principal, para el protocolo del spec. */
  private regressionContext(job: JobDto, wts: JobWorktreeDto[]): RegressionContext {
    const primary = wts.find((w) => w.isPrimary) ?? wts[0];
    return {
      wrapperPath: path.join(path.dirname(this.opts.wrapperPath), 'unit-run.mjs'),
      outDir: e2eDirFor(this.opts.artifactsDir, job.id),
      frameworks: primary ? detectProject(primary.worktreePath).testFrameworks : [],
      testCommand: primary ? this.toFixWorktree(primary).testCommand : undefined,
      required: this.opts.regressionRequired,
    };
  }

  private toFixWorktree(w: JobWorktreeDto): FixWorktree {
    return {
      repoName: w.repoName,
      worktreePath: w.worktreePath,
      isPrimary: w.isPrimary,
      testCommand: this.repos.settingsFor(w.repoName).testCommand,
    };
  }

  /** Archivos tocados según git en cada worktree, con prefijo <repo>/. Vacío si todo está limpio. */
  private async detectChangedFiles(jobId: string, reported: string[]): Promise<string[]> {
    const wts = this.jobs.activeWorktrees(jobId);
    if (wts.length === 0) return reported;
    const files: string[] = [];
    let gitFailed = false;
    for (const wt of wts) {
      try {
        for (const p of await this.worktreeChanges(wt)) files.push(`${wt.repoName}/${p}`);
      } catch {
        gitFailed = true;
      }
    }
    return files.length === 0 && gitFailed ? reported : files;
  }

  /**
   * Cambios del fix en un worktree (rutas relativas): git status menos lo que ya estaba sucio
   * tras la instalación o COPY_FILES y menos el andamiaje de la prueba.
   */
  private async worktreeChanges(wt: JobWorktreeDto): Promise<string[]> {
    const res = await run('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: wt.worktreePath,
      timeoutMs: 30_000,
      maxOutput: 8 * 1024 * 1024,
    });
    const baseline = new Set(wt.baselineDirty);
    return parsePorcelain(res.stdout).filter((p) => !baseline.has(p) && !p.startsWith(`${E2E_DIR}/`) && !path.basename(p).startsWith('_bugs-manager'));
  }

  private jobLink(jobId: string): string {
    return `${this.opts.dashboardUrl}/?job=${jobId}`;
  }
}

type FixedOutcome = Extract<ClaudeOutcome, { status: 'fixed' }>;

/** Ticket mínimo reconstruido desde el job cuando Jira no está disponible. */
function issueFromJob(job: JobDto): JiraIssue {
  return {
    key: job.ticketKey,
    summary: job.ticketSummary ?? '',
    description: '(descripción no disponible: no se pudo releer el ticket en Jira)',
    status: job.ticketStatus ?? 'unknown',
    statusCategory: 'unknown',
    issueType: 'Bug',
    projectKey: job.ticketKey.split('-')[0] ?? '',
    reporter: job.requestedBy,
    url: job.ticketUrl ?? '',
    comments: [],
  };
}

/** Transición cuyo estado destino (o nombre) coincide con el que buscamos. */
function findTransition(transitions: Array<{ id: string; name: string; to: string }>, target: string): { id: string } | undefined {
  const t = target.trim().toLowerCase();
  return transitions.find((x) => x.to.trim().toLowerCase() === t) ?? transitions.find((x) => x.name.trim().toLowerCase() === t);
}

function threadOf(job: JobDto): ThreadRef | undefined {
  return job.slackChannel && job.slackThreadTs ? { channel: job.slackChannel, ts: job.slackThreadTs } : undefined;
}

/** Eco en el hilo de lo que llega fuera de Slack (dashboard o DABOT por voz). */
function viaIcon(via: AnswerVia): string {
  return via === 'voice' ? ':microphone:' : ':desktop_computer:';
}

function viaLabel(via: AnswerVia): string {
  return via === 'voice' ? 'por voz (DABOT)' : 'desde el dashboard';
}

function numbered(items: string[]): string {
  return items.map((q, i) => `${i + 1}. ${q}`).join('\n');
}
