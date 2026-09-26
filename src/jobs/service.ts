import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ticketLogger } from '../logger.js';
import {
  isAwaiting,
  isTerminal,
  type AnswerVia,
  type JobDetailDto,
  type JobDto,
  type JobArtifactDto,
  type JobMessageDto,
  type JobPhase,
  type JobStatus,
  type JobWorktreeDto,
  type MessageKind,
  type TestsResult,
  type TriageResult,
  type RegressionInfo,
} from '../shared/job-types.js';
import type { IncomingBug, JiraIssue, ThreadRef } from '../types.js';
import type { JobRepository, ListFilter } from './repository.js';

export interface JobServiceEvents {
  /** Se emite tras cualquier cambio en un job (para SSE). */
  job: [job: JobDto];
  /** Nuevo mensaje en la transcripción de Claude Code de un job. */
  message: [message: JobMessageDto];
}

export interface FixResult {
  branch?: string;
  worktreePath?: string;
  filesChanged?: string[];
  testsResult?: TestsResult;
  summary?: string;
}

/**
 * Reglas de negocio sobre jobs: creación, transiciones y bitácora. No sabe
 * nada de Slack ni de Jira; quien orquesta (Intake) decide qué comunicar.
 * Cada cambio queda en job_events y se emite por `on('job')`.
 */
export class JobService extends EventEmitter<JobServiceEvents> {
  constructor(private readonly repo: JobRepository) {
    super();
  }

  create(bug: IncomingBug): JobDto {
    const now = Date.now();
    const job = this.repo.insert({
      id: randomUUID(),
      ticketKey: bug.key,
      status: 'received',
      source: bug.source,
      requestedBy: bug.requestedBy,
      notes: bug.notes ?? null,
      sourceBranch: bug.sourceBranch ?? null,
      createdAt: now,
      updatedAt: now,
    });
    this.log(job, 'created', `Job creado (${bug.source}) a petición de ${bug.requestedBy}${bug.notes ? ` con notas: ${bug.notes}` : ''}`, {
      sourceBranch: bug.sourceBranch,
      notes: bug.notes,
    });
    return this.emitJob(job);
  }

  setTicket(id: string, issue: JiraIssue): JobDto {
    const job = this.repo.update(id, {
      ticketSummary: issue.summary,
      ticketUrl: issue.url,
      ticketStatus: issue.status,
    });
    this.log(job, 'ticket_read', `Ticket leído en Jira: "${issue.summary}" (estado ${issue.status})`, {
      status: issue.status,
      comments: issue.comments.length,
    });
    return this.emitJob(job);
  }

  attachThread(id: string, thread: ThreadRef, permalink?: string): JobDto {
    const job = this.repo.update(id, {
      slackChannel: thread.channel,
      slackThreadTs: thread.ts,
      slackPermalink: permalink ?? null,
    });
    this.log(job, 'thread_opened', 'Hilo abierto en Slack', { permalink });
    return this.emitJob(job);
  }

  /** Cambia de estado y lo registra. `message` es la línea que verás en el log del ticket. */
  transition(id: string, status: JobStatus, message: string, patch: Partial<JobPatch> = {}): JobDto {
    const prev = this.repo.getOrThrow(id);
    if (isTerminal(prev.status) && status !== prev.status) {
      throw new JobStateError(`El job ${prev.ticketKey} ya terminó (${prev.status}); no puede pasar a ${status}`);
    }
    const now = Date.now();
    const job = this.repo.update(id, {
      status,
      ...patch,
      filesChanged: patch.filesChanged ? JSON.stringify(patch.filesChanged) : undefined,
      regressionTest: patch.regressionTest === undefined ? undefined : patch.regressionTest ? JSON.stringify(patch.regressionTest) : null,
      startedAt: status === 'working' && !prev.startedAt ? now : undefined,
      finishedAt: isTerminal(status) ? now : undefined,
      pendingQuestion: isAwaiting(status) ? (patch.pendingQuestion ?? prev.pendingQuestion) : null,
    });
    this.log(job, 'status_changed', message, { from: prev.status, to: status });
    return this.emitJob(job);
  }

  /** Pone el job a esperar una respuesta humana con la pregunta destacada. */
  ask(id: string, status: 'awaiting_jira_status' | 'awaiting_branch' | 'awaiting_repos' | 'awaiting_clarification', question: string): JobDto {
    return this.transition(id, status, `Pregunta pendiente: ${question}`, { pendingQuestion: question });
  }

  /**
   * Registra una respuesta humana (desde Slack o el dashboard) y saca al job del
   * estado awaiting_*. Devuelve el job actualizado y el estado en el que estaba.
   */
  answer(id: string, text: string, via: AnswerVia, who: string): { job: JobDto; wasAwaiting: JobStatus } {
    const prev = this.repo.getOrThrow(id);
    if (!isAwaiting(prev.status)) {
      throw new JobStateError(`El job ${prev.ticketKey} no está esperando respuesta (estado ${prev.status})`);
    }
    const answer = text.trim();
    if (!answer) throw new JobStateError('La respuesta está vacía');

    this.repo.addEvent(id, 'answer', `Respuesta (${via}, ${who}): ${answer}`, { via, who, answer });

    let job: JobDto;
    if (prev.status === 'awaiting_branch') {
      job = this.transition(id, 'triaging', `Rama origen fijada: ${answer}. Analizando en qué repositorios está el bug…`, { sourceBranch: answer });
    } else if (prev.status === 'awaiting_repos') {
      job = this.transition(id, 'creating_worktree', 'Repositorios confirmados. Creando worktrees…');
    } else {
      // Fase 4: reanudará la sesión de Claude Code con esta respuesta.
      job = this.transition(id, 'working', 'Aclaración recibida; se reanudará el trabajo');
    }
    return { job, wasAwaiting: prev.status };
  }

  /** Añade un mensaje a la transcripción de Claude Code y lo emite por SSE. */
  addMessage(id: string, msg: { kind: MessageKind; toolName: string | null; summary: string; content: unknown }): JobMessageDto {
    const saved = this.repo.addMessage(id, msg);
    this.emit('message', saved);
    return saved;
  }

  listMessages(id: string, afterId = 0): JobMessageDto[] {
    return this.repo.listMessages(id, afterId);
  }

  /** Registra la sesión de Claude Code de la fase indicada (triaje o fix). */
  setSession(id: string, sessionId: string, phase: JobPhase = 'fix'): JobDto {
    const job = this.repo.update(id, phase === 'triage' ? { triageSessionId: sessionId, phase } : { claudeSessionId: sessionId, phase });
    this.log(job, phase === 'triage' ? 'triage_started' : 'claude_started', `Sesión de ${phase === 'triage' ? 'triaje' : 'Claude Code'} iniciada (${sessionId})`, {
      sessionId,
      phase,
    });
    return this.emitJob(job);
  }

  setTriageResult(id: string, result: TriageResult): JobDto {
    const job = this.repo.update(id, { triageResult: JSON.stringify(result) });
    this.log(job, 'triage_result', `Triaje: ${result.repos.map((r) => `${r.name} (${r.confidence})`).join(', ')}`, { repos: result.repos });
    return this.emitJob(job);
  }

  // ---- worktrees por job ----------------------------------------------------

  addWorktree(
    id: string,
    wt: { repoName: string; repoPath: string; worktreePath: string; branch: string; isPrimary: boolean; installCommand: string | null; baselineDirty: string[] },
  ): JobWorktreeDto {
    const saved = this.repo.addWorktree({ jobId: id, ...wt, baselineDirty: JSON.stringify(wt.baselineDirty) });
    const patch = wt.isPrimary ? { branch: wt.branch, worktreePath: wt.worktreePath, worktreeRemovedAt: null } : {};
    const job = this.repo.update(id, patch);
    this.log(job, 'worktree_created', `Worktree ${wt.repoName} creado en ${wt.worktreePath} (rama ${wt.branch})`, { repo: wt.repoName, primary: wt.isPrimary });
    this.emitJob(job);
    return saved;
  }

  addArtifact(id: string, art: { phase: string; kind: string; path: string; mime: string }): void {
    this.repo.addArtifact(id, art);
  }

  listArtifacts(id: string): JobArtifactDto[] {
    return this.repo.listArtifacts(id);
  }

  artifactPath(id: string, artifactId: number): string | undefined {
    return this.repo.artifactPath(id, artifactId);
  }

  listWorktrees(id: string): JobWorktreeDto[] {
    return this.repo.listWorktrees(id);
  }

  /** Worktrees vivos (no eliminados) del job. */
  activeWorktrees(id: string): JobWorktreeDto[] {
    return this.repo.listWorktrees(id).filter((w) => !w.removedAt);
  }

  /** Registra el PR abierto desde la rama de un worktree y refresca el job en el dashboard. */
  setWorktreePullRequest(id: string, worktreeId: number, pr: { prUrl: string; prId: number; prDestination: string; pushedAt: number; commitSha: string | null }): JobDto {
    this.repo.updateWorktree(worktreeId, pr);
    return this.emitJob(this.repo.getOrThrow(id));
  }

  markWorktreeRemoved(id: string, worktree: JobWorktreeDto, who: string): JobDto {
    this.repo.markWorktreeRemoved(worktree.id);
    const remaining = this.activeWorktrees(id);
    const job = this.repo.update(id, remaining.length === 0 ? { worktreeRemovedAt: Date.now() } : {});
    this.log(job, 'worktree_removed', `Worktree ${worktree.repoName} eliminado del disco (${who})`, { path: worktree.worktreePath });
    return this.emitJob(job);
  }

  /** Acumula coste y turnos de una ejecución (inicio o reanudación). */
  recordUsage(id: string, costUsd: number | undefined, numTurns: number | undefined): JobDto {
    const prev = this.repo.getOrThrow(id);
    const job = this.repo.update(id, {
      claudeCostUsd: costUsd === undefined ? prev.claudeCostUsd : (prev.claudeCostUsd ?? 0) + costUsd,
      claudeNumTurns: numTurns === undefined ? prev.claudeNumTurns : (prev.claudeNumTurns ?? 0) + numTurns,
    });
    return this.emitJob(job);
  }

  bumpClarificationRounds(id: string): JobDto {
    const prev = this.repo.getOrThrow(id);
    return this.emitJob(this.repo.update(id, { clarificationRounds: prev.clarificationRounds + 1 }));
  }

  /** Worktree creado con éxito: guarda rama y ruta. El estado lo decide quien orquesta. */
  worktreeReady(id: string, branch: string, worktreePath: string, details: Record<string, unknown> = {}): JobDto {
    const job = this.repo.update(id, { branch, worktreePath, worktreeRemovedAt: null });
    this.log(job, 'worktree_created', `Worktree creado en ${worktreePath} (rama ${branch})`, details);
    return this.emitJob(job);
  }

  worktreeRemoved(id: string, who: string): JobDto {
    const job = this.repo.update(id, { worktreeRemovedAt: Date.now() });
    this.log(job, 'worktree_removed', `Worktree eliminado del disco (${who})`, { path: job.worktreePath });
    return this.emitJob(job);
  }

  listTerminalWithWorktree(): JobDto[] {
    return this.repo.findTerminalWithWorktree();
  }

  /**
   * Reabre un job terminado (fixed, cannot_fix, failed) para continuar la sesión con
   * una instrucción del equipo. Es la única vía de salir de un estado terminal.
   */
  reopen(id: string, why: string): JobDto {
    const prev = this.repo.getOrThrow(id);
    if (!['fixed', 'cannot_fix', 'failed'].includes(prev.status)) {
      throw new JobStateError(`El job ${prev.ticketKey} no se puede reabrir desde ${prev.status}`);
    }
    if (!prev.claudeSessionId) throw new JobStateError(`El job ${prev.ticketKey} no tiene sesión de Claude Code que continuar`);
    if (!prev.worktreePath || prev.worktreeRemovedAt) {
      throw new JobStateError(`El worktree de ${prev.ticketKey} ya no existe; pide /fix de nuevo`);
    }
    const job = this.repo.update(id, { status: 'working', finishedAt: null, pendingQuestion: null });
    this.log(job, 'reopened', `Job reabierto: ${why}`, { from: prev.status });
    return this.emitJob(job);
  }

  /** Añade texto a las notas del equipo (antes de que exista sesión). */
  appendNotes(id: string, text: string): JobDto {
    const prev = this.repo.getOrThrow(id);
    const notes = prev.notes ? `${prev.notes}\n${text.trim()}` : text.trim();
    const job = this.repo.update(id, { notes });
    this.log(job, 'notes_added', `Nota añadida: ${text.trim()}`);
    return this.emitJob(job);
  }

  discard(id: string, reason: string): JobDto {
    return this.transition(id, 'discarded', `Descartado: ${reason}`, { failureReason: reason });
  }

  fail(id: string, reason: string): JobDto {
    return this.transition(id, 'failed', `Fallo: ${reason}`, { failureReason: reason });
  }

  note(id: string, type: string, message: string, data?: Record<string, unknown>): void {
    const job = this.repo.getOrThrow(id);
    this.log(job, type, message, data);
    this.emitJob(job);
  }

  get(id: string): JobDto | undefined {
    return this.repo.get(id);
  }

  getDetail(id: string): JobDetailDto | undefined {
    const job = this.repo.get(id);
    return job
      ? { ...job, events: this.repo.listEvents(id), worktrees: this.repo.listWorktrees(id), artifacts: this.repo.listArtifacts(id) }
      : undefined;
  }

  list(filter?: ListFilter): JobDto[] {
    return this.repo.list(filter);
  }

  findActiveByTicket(key: string): JobDto | undefined {
    return this.repo.findActiveByTicket(key);
  }

  findByThread(channel: string, threadTs: string): JobDto | undefined {
    return this.repo.findByThread(channel, threadTs);
  }

  private log(job: JobDto, type: string, message: string, data?: Record<string, unknown>): void {
    this.repo.addEvent(job.id, type, message, data);
    ticketLogger(job.ticketKey, { job: job.id, status: job.status }).info({ event: type, ...data }, message);
  }

  private emitJob(job: JobDto): JobDto {
    this.emit('job', job);
    return job;
  }
}

export interface JobPatch {
  sourceBranch: string | null;
  branch: string | null;
  worktreePath: string | null;
  worktreeRemovedAt: number | null;
  claudeSessionId: string | null;
  pendingQuestion: string | null;
  fixSummary: string | null;
  issue: string | null;
  solution: string | null;
  notesForQa: string | null;
  e2eMode: 'e2e' | 'code_only' | 'awaiting_env' | null;
  appUrl: string | null;
  reproduction: string | null;
  filesChanged: string[];
  testsResult: TestsResult | null;
  testsDetail: string | null;
  regressionTest: RegressionInfo | null;
  failureReason: string | null;
}

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobStateError';
  }
}
