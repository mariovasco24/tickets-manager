import { and, desc, eq, gt, inArray, isNotNull, isNull, like, not, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  jobArtifacts,
  jobEvents,
  jobMessages,
  jobWorktrees,
  jobs,
  type JobArtifactRow,
  type JobEventRow,
  type JobMessageRow,
  type JobRow,
  type JobWorktreeRow,
  type NewJobRow,
} from '../db/schema.js';
import {
  TERMINAL_STATUSES,
  type JobArtifactDto,
  type JobDto,
  type JobEventDto,
  type JobMessageDto,
  type JobStatus,
  type JobWorktreeDto,
  type RegressionInfo,
  type MessageKind,
  type TriageResult,
} from '../shared/job-types.js';

export interface ListFilter {
  status?: JobStatus;
  /** Búsqueda por clave de ticket (contiene, sin distinguir mayúsculas). */
  q?: string;
  limit?: number;
}

/** Acceso a datos puro. Sin lógica de negocio ni Slack. */
export class JobRepository {
  constructor(private readonly db: Db) {}

  insert(row: NewJobRow): JobDto {
    this.db.insert(jobs).values(row).run();
    return this.getOrThrow(row.id);
  }

  update(id: string, patch: Partial<Omit<JobRow, 'id' | 'createdAt'>>): JobDto {
    this.db
      .update(jobs)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(jobs.id, id))
      .run();
    return this.getOrThrow(id);
  }

  get(id: string): JobDto | undefined {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? toDto(row) : undefined;
  }

  getOrThrow(id: string): JobDto {
    const job = this.get(id);
    if (!job) throw new Error(`Job ${id} no existe`);
    return job;
  }

  list(filter: ListFilter = {}): JobDto[] {
    const conds = [];
    if (filter.status) conds.push(eq(jobs.status, filter.status));
    if (filter.q) {
      const q = `%${filter.q.trim().toUpperCase()}%`;
      conds.push(or(like(jobs.ticketKey, q), like(jobs.ticketSummary, `%${filter.q.trim()}%`)));
    }
    return this.db
      .select()
      .from(jobs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(filter.limit ?? 500)
      .all()
      .map(toDto);
  }

  /** Job no terminal para un ticket, si lo hay (para idempotencia). */
  findActiveByTicket(ticketKey: string): JobDto | undefined {
    const row = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ticketKey, ticketKey), not(inArray(jobs.status, [...TERMINAL_STATUSES]))))
      .orderBy(desc(jobs.createdAt))
      .get();
    return row ? toDto(row) : undefined;
  }

  /** Jobs terminados con algún worktree aún en disco (candidatos a limpieza). */
  findTerminalWithWorktree(): JobDto[] {
    const withWt = new Set(
      this.db.select({ jobId: jobWorktrees.jobId }).from(jobWorktrees).where(isNull(jobWorktrees.removedAt)).all().map((r) => r.jobId),
    );
    return this.db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, [...TERMINAL_STATUSES]))
      .orderBy(desc(jobs.createdAt))
      .all()
      .filter((j) => withWt.has(j.id) || (j.worktreePath && !j.worktreeRemovedAt))
      .map(toDto);
  }

  // ---- worktrees por job ----------------------------------------------------

  addWorktree(row: Omit<JobWorktreeRow, 'id' | 'createdAt' | 'removedAt' | 'prUrl' | 'prId' | 'prDestination' | 'pushedAt' | 'commitSha'>): JobWorktreeDto {
    const res = this.db
      .insert(jobWorktrees)
      .values({ ...row, createdAt: Date.now() })
      .run();
    const saved = this.db
      .select()
      .from(jobWorktrees)
      .where(eq(jobWorktrees.id, Number(res.lastInsertRowid)))
      .get();
    if (!saved) throw new Error('No se pudo leer el worktree recién insertado');
    return worktreeToDto(saved);
  }

  listWorktrees(jobId: string): JobWorktreeDto[] {
    return this.db.select().from(jobWorktrees).where(eq(jobWorktrees.jobId, jobId)).orderBy(jobWorktrees.id).all().map(worktreeToDto);
  }

  updateWorktree(id: number, patch: Partial<Pick<JobWorktreeRow, 'prUrl' | 'prId' | 'prDestination' | 'pushedAt' | 'commitSha'>>): void {
    this.db.update(jobWorktrees).set(patch).where(eq(jobWorktrees.id, id)).run();
  }

  addArtifact(jobId: string, art: { phase: string; kind: string; path: string; mime: string }): JobArtifactDto {
    const res = this.db
      .insert(jobArtifacts)
      .values({ jobId, ...art, createdAt: Date.now() })
      .run();
    const row = this.db
      .select()
      .from(jobArtifacts)
      .where(eq(jobArtifacts.id, Number(res.lastInsertRowid)))
      .get();
    if (!row) throw new Error('No se pudo leer el artefacto recién insertado');
    return artifactToDto(row);
  }

  listArtifacts(jobId: string): JobArtifactDto[] {
    return this.db.select().from(jobArtifacts).where(eq(jobArtifacts.jobId, jobId)).orderBy(jobArtifacts.id).all().map(artifactToDto);
  }

  /** Ruta en disco de un artefacto (no sale en el DTO para no exponer el sistema de archivos). */
  artifactPath(jobId: string, id: number): string | undefined {
    const row = this.db
      .select()
      .from(jobArtifacts)
      .where(and(eq(jobArtifacts.jobId, jobId), eq(jobArtifacts.id, id)))
      .get();
    return row?.path;
  }

  markWorktreeRemoved(id: number): void {
    this.db.update(jobWorktrees).set({ removedAt: Date.now() }).where(eq(jobWorktrees.id, id)).run();
  }

  findByThread(channel: string, threadTs: string): JobDto | undefined {
    const row = this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.slackChannel, channel), eq(jobs.slackThreadTs, threadTs)))
      .get();
    return row ? toDto(row) : undefined;
  }

  addEvent(jobId: string, type: string, message: string, data?: Record<string, unknown>): JobEventDto {
    const res = this.db
      .insert(jobEvents)
      .values({ jobId, type, message, data: data ? JSON.stringify(data) : null, createdAt: Date.now() })
      .run();
    const row = this.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.id, Number(res.lastInsertRowid)))
      .get();
    if (!row) throw new Error('No se pudo leer el evento recién insertado');
    return eventToDto(row);
  }

  listEvents(jobId: string): JobEventDto[] {
    return this.db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(jobEvents.id).all().map(eventToDto);
  }

  addMessage(jobId: string, msg: { kind: MessageKind; toolName: string | null; summary: string; content: unknown }): JobMessageDto {
    const res = this.db
      .insert(jobMessages)
      .values({
        jobId,
        kind: msg.kind,
        toolName: msg.toolName,
        summary: msg.summary.slice(0, 500),
        content: msg.content === undefined ? null : JSON.stringify(msg.content),
        createdAt: Date.now(),
      })
      .run();
    const row = this.db
      .select()
      .from(jobMessages)
      .where(eq(jobMessages.id, Number(res.lastInsertRowid)))
      .get();
    if (!row) throw new Error('No se pudo leer el mensaje recién insertado');
    return messageToDto(row);
  }

  listMessages(jobId: string, afterId = 0): JobMessageDto[] {
    return this.db
      .select()
      .from(jobMessages)
      .where(and(eq(jobMessages.jobId, jobId), gt(jobMessages.id, afterId)))
      .orderBy(jobMessages.id)
      .all()
      .map(messageToDto);
  }
}

function messageToDto(row: JobMessageRow): JobMessageDto {
  let content: unknown = null;
  if (row.content) {
    try {
      content = JSON.parse(row.content);
    } catch {
      content = row.content;
    }
  }
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind as MessageKind,
    toolName: row.toolName,
    summary: row.summary,
    content,
    createdAt: row.createdAt,
  };
}

function toDto(row: JobRow): JobDto {
  let triageResult: TriageResult | null = null;
  if (row.triageResult) {
    try {
      triageResult = JSON.parse(row.triageResult) as TriageResult;
    } catch {
      triageResult = null;
    }
  }
  return {
    ...row,
    filesChanged: parseJsonArray(row.filesChanged),
    regressionTest: parseJsonObject<RegressionInfo>(row.regressionTest),
    triageResult,
  };
}

function artifactToDto(row: JobArtifactRow): JobArtifactDto {
  return {
    id: row.id,
    jobId: row.jobId,
    phase: row.phase === 'after' ? 'after' : 'before',
    kind: (['video', 'screenshot', 'trace'].includes(row.kind) ? row.kind : 'screenshot') as JobArtifactDto['kind'],
    mime: row.mime,
    createdAt: row.createdAt,
  };
}

function worktreeToDto(row: JobWorktreeRow): JobWorktreeDto {
  return { ...row, isPrimary: Boolean(row.isPrimary), baselineDirty: parseJsonArray(row.baselineDirty) };
}

function eventToDto(row: JobEventRow): JobEventDto {
  let data: Record<string, unknown> | null = null;
  if (row.data) {
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      data = { raw: row.data };
    }
  }
  return { id: row.id, jobId: row.jobId, type: row.type, message: row.message, data, createdAt: row.createdAt };
}

function parseJsonObject<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
