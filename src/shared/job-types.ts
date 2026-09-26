/**
 * Tipos compartidos entre el servidor y el dashboard (web/). Sin dependencias
 * de Node para que Vite pueda importarlos tal cual.
 */

export const JOB_STATUSES = [
  'received',
  'awaiting_jira_status',
  'awaiting_branch',
  'triaging',
  'awaiting_repos',
  'creating_worktree',
  'working',
  'awaiting_clarification',
  'fixed',
  'cannot_fix',
  'failed',
  'discarded',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ['fixed', 'cannot_fix', 'failed', 'discarded'];
export const AWAITING_STATUSES: readonly JobStatus[] = ['awaiting_jira_status', 'awaiting_branch', 'awaiting_repos', 'awaiting_clarification'];

export const STATUS_LABELS: Record<JobStatus, string> = {
  received: 'Recibido',
  awaiting_jira_status: 'Estado en Jira',
  awaiting_branch: 'Esperando rama',
  triaging: 'Analizando repos',
  awaiting_repos: 'Confirmar repos',
  creating_worktree: 'Creando worktrees',
  working: 'Trabajando',
  awaiting_clarification: 'Esperando aclaración',
  fixed: 'Solucionado',
  cannot_fix: 'No se pudo',
  failed: 'Fallido',
  discarded: 'Descartado',
};

/** En qué sesión de Claude Code está el job: triaje (repo de conocimiento) o fix (worktrees). */
export type JobPhase = 'triage' | 'fix';

export interface TriageRepo {
  name: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface TriageResult {
  repos: TriageRepo[];
  analysis: string;
}

export interface JobWorktreeDto {
  id: number;
  jobId: string;
  repoName: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  isPrimary: boolean;
  installCommand: string | null;
  /** Archivos que git ya veía modificados tras la instalación; no cuentan como cambios del fix. */
  baselineDirty: string[];
  /** Pull request abierto desde la rama de este worktree (siempre tras confirmación humana). */
  prUrl: string | null;
  prId: number | null;
  prDestination: string | null;
  pushedAt: number | null;
  commitSha: string | null;
  createdAt: number;
  removedAt: number | null;
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isAwaiting(status: JobStatus): boolean {
  return AWAITING_STATUSES.includes(status);
}

export type TriggerSource = 'webhook' | 'manual';
export type TestsResult = 'passed' | 'failed' | 'none';

/** Spec de regresión del fix, con el veredicto del servicio (rojo antes / verde después). */
export interface RegressionInfo {
  kind: 'unit' | 'e2e' | 'none';
  /** Specs implicados, como los reportó Claude o como aparecen en el diff. */
  files: string[];
  reason?: string;
  command?: string;
  /** verified: cubre el bug · mismatch/unverified: hay spec pero no demuestra nada · none: sin spec · pending: espera decisión humana · accepted: aceptado sin spec por una persona. */
  verdict: 'verified' | 'mismatch' | 'unverified' | 'none' | 'pending' | 'accepted';
  label: string;
  acceptedBy?: string;
}
export type AnswerVia = 'slack' | 'dashboard';

export interface JobDto {
  id: string;
  ticketKey: string;
  ticketSummary: string | null;
  ticketUrl: string | null;
  ticketStatus: string | null;
  status: JobStatus;
  source: TriggerSource;
  requestedBy: string;
  notes: string | null;
  sourceBranch: string | null;
  branch: string | null;
  worktreePath: string | null;
  worktreeRemovedAt: number | null;
  slackChannel: string | null;
  slackThreadTs: string | null;
  slackPermalink: string | null;
  claudeSessionId: string | null;
  phase: JobPhase;
  triageSessionId: string | null;
  triageResult: TriageResult | null;
  clarificationRounds: number;
  claudeCostUsd: number | null;
  claudeNumTurns: number | null;
  pendingQuestion: string | null;
  fixSummary: string | null;
  /** Plantilla de reporte QA (en inglés). */
  issue: string | null;
  solution: string | null;
  notesForQa: string | null;
  e2eMode: 'e2e' | 'code_only' | 'awaiting_env' | null;
  appUrl: string | null;
  reproduction: string | null;
  filesChanged: string[];
  testsResult: TestsResult | null;
  testsDetail: string | null;
  /** Spec de regresión y su veredicto. */
  regressionTest: RegressionInfo | null;
  failureReason: string | null;
  /** Epoch ms */
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobEventDto {
  id: number;
  jobId: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: number;
}

export interface JobArtifactDto {
  id: number;
  jobId: string;
  phase: 'before' | 'after';
  kind: 'video' | 'screenshot' | 'trace';
  mime: string;
  createdAt: number;
}

export interface JobDetailDto extends JobDto {
  events: JobEventDto[];
  worktrees: JobWorktreeDto[];
  artifacts: JobArtifactDto[];
}

export type MessageKind = 'system' | 'assistant_text' | 'tool_use' | 'tool_result' | 'user_prompt' | 'result' | 'error';

/** Un evento de la sesión de Claude Code, tal como se muestra en el dashboard. */
export interface JobMessageDto {
  id: number;
  jobId: string;
  kind: MessageKind;
  toolName: string | null;
  summary: string;
  /** Contenido completo (texto, input de la herramienta, resultado…), ya parseado. */
  content: unknown;
  createdAt: number;
}

export interface MetaDto {
  statuses: readonly JobStatus[];
  devMode: boolean;
  /** Si el servicio ofrece subir la rama y abrir el PR tras el fix. */
  prEnabled: boolean;
  /** Estado de Jira que se ofrece tras abrir el PR; null = no se ofrece. */
  jiraMergeStatus: string | null;
}
