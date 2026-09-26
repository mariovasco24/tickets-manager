import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { JobPhase, JobStatus, TestsResult, TriggerSource } from '../shared/job-types.js';

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    ticketKey: text('ticket_key').notNull(),
    ticketSummary: text('ticket_summary'),
    ticketUrl: text('ticket_url'),
    ticketStatus: text('ticket_status'),
    status: text('status').$type<JobStatus>().notNull(),
    source: text('source').$type<TriggerSource>().notNull(),
    requestedBy: text('requested_by').notNull(),
    /** Contexto adicional dado por el equipo al pedir el fix. */
    notes: text('notes'),
    sourceBranch: text('source_branch'),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    /** Epoch ms cuando se eliminó el worktree del disco (limpieza). */
    worktreeRemovedAt: integer('worktree_removed_at'),
    slackChannel: text('slack_channel'),
    slackThreadTs: text('slack_thread_ts'),
    slackPermalink: text('slack_permalink'),
    claudeSessionId: text('claude_session_id'),
    /** triage (sesión en el repo de conocimiento) | fix (sesión en los worktrees) */
    phase: text('phase').$type<JobPhase>().notNull().default('triage'),
    triageSessionId: text('triage_session_id'),
    /** JSON TriageResult */
    triageResult: text('triage_result'),
    clarificationRounds: integer('clarification_rounds').notNull().default(0),
    claudeCostUsd: real('claude_cost_usd'),
    claudeNumTurns: integer('claude_num_turns'),
    pendingQuestion: text('pending_question'),
    fixSummary: text('fix_summary'),
    /** Plantilla de reporte QA (en inglés). */
    issue: text('issue'),
    solution: text('solution'),
    notesForQa: text('notes_for_qa'),
    /** e2e = se reprodujo en navegador; code_only = el equipo decidió arreglar sin entorno. */
    e2eMode: text('e2e_mode').$type<'e2e' | 'code_only' | 'awaiting_env'>(),
    /** URL del dev server levantado para este job (informativa). */
    appUrl: text('app_url'),
    /** Veredicto del servicio sobre la reproducción (texto ya legible). */
    reproduction: text('reproduction'),
    /** JSON: string[] */
    filesChanged: text('files_changed'),
    testsResult: text('tests_result').$type<TestsResult>(),
    /** Resumen de la suite reportado por Claude: totales, archivos que fallan, si son preexistentes. */
    testsDetail: text('tests_detail'),
    /** JSON RegressionInfo: spec de regresión del fix y veredicto del servicio. */
    regressionTest: text('regression_test'),
    failureReason: text('failure_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('jobs_ticket_key_idx').on(t.ticketKey),
    index('jobs_status_idx').on(t.status),
    index('jobs_thread_idx').on(t.slackChannel, t.slackThreadTs),
  ],
);

/** Bitácora append-only: nunca se actualiza ni se borra una fila salvo al borrar el job. */
export const jobEvents = sqliteTable(
  'job_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message').notNull(),
    /** JSON libre con contexto del evento. */
    data: text('data'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('job_events_job_id_idx').on(t.jobId, t.id)],
);

/**
 * Transcripción de la sesión de Claude Code, un evento del stream-json por fila:
 * texto del asistente, llamadas a herramientas, resultados, resultado final.
 */
export const jobMessages = sqliteTable(
  'job_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** system | assistant_text | tool_use | tool_result | user_prompt | result | error */
    kind: text('kind').notNull(),
    toolName: text('tool_name'),
    /** Resumen legible de una línea (ruta leída, comando, primeras palabras…). */
    summary: text('summary').notNull(),
    /** JSON con el contenido completo (recortado a un máximo por fila). */
    content: text('content'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('job_messages_job_id_idx').on(t.jobId, t.id)],
);

/** Un worktree por repositorio implicado en el job. Todos comparten la misma rama. */
export const jobWorktrees = sqliteTable(
  'job_worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    repoName: text('repo_name').notNull(),
    repoPath: text('repo_path').notNull(),
    worktreePath: text('worktree_path').notNull(),
    branch: text('branch').notNull(),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    installCommand: text('install_command'),
    /** JSON string[]: archivos que git ya veía modificados tras instalar (p. ej. package-lock.json); se descuentan del reporte. */
    baselineDirty: text('baseline_dirty'),
    /** Pull request abierto desde esta rama hacia la rama origen. Nunca se mergea desde aquí. */
    prUrl: text('pr_url'),
    prId: integer('pr_id'),
    prDestination: text('pr_destination'),
    pushedAt: integer('pushed_at'),
    commitSha: text('commit_sha'),
    createdAt: integer('created_at').notNull(),
    removedAt: integer('removed_at'),
  },
  (t) => [index('job_worktrees_job_id_idx').on(t.jobId)],
);

/** Evidencia de la reproducción: vídeos, capturas y trazas de Playwright. */
export const jobArtifacts = sqliteTable(
  'job_artifacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    phase: text('phase').notNull(),
    kind: text('kind').notNull(),
    path: text('path').notNull(),
    mime: text('mime').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('job_artifacts_job_id_idx').on(t.jobId)],
);

export type JobRow = typeof jobs.$inferSelect;
export type JobArtifactRow = typeof jobArtifacts.$inferSelect;
export type JobMessageRow = typeof jobMessages.$inferSelect;
export type JobWorktreeRow = typeof jobWorktrees.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type JobEventRow = typeof jobEvents.$inferSelect;
