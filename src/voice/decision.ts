import type { JobDetailDto } from '../shared/job-types.js';
import { plain } from './speech.js';

/**
 * Qué se espera de una persona en un job, con las mismas reglas que los
 * botones de Slack y del dashboard. Las ofertas tras el fix (PR → estado de
 * merge → comentario) no son estados del job sino eventos, así que se deducen
 * igual que en el dashboard.
 */
export type DecisionKind =
  | 'jira_status'
  | 'branch'
  | 'repos'
  | 'env'
  | 'regression'
  | 'clarification'
  | 'pull_request'
  | 'jira_merge'
  | 'jira_comment';

export interface VoiceOption {
  id: string;
  label: string;
}

export interface VoiceDecision {
  kind: DecisionKind;
  jobId: string;
  ticketKey: string;
  /** Pregunta en texto plano (para pantalla). */
  question: string;
  /** Opciones en orden; en las binarias la primera es la afirmativa y la segunda la negativa. */
  options: VoiceOption[];
  /** Admite respuesta libre (rama, aclaración para Claude). */
  freeText: boolean;
}

export interface DecisionContext {
  prEnabled: boolean;
  /** Estado de espera de merge que se ofrece tras el PR; undefined = no se ofrece. */
  jiraMergeStatus: string | undefined;
  jiraAllowComment: boolean;
  /** Ramas del remoto ya ordenadas (develop, main, release/* primero). */
  branches: readonly string[];
}

export const MAX_BRANCH_OPTIONS = 6;

export function pendingDecision(job: JobDetailDto, ctx: DecisionContext): VoiceDecision | undefined {
  const base = { jobId: job.id, ticketKey: job.ticketKey };
  const question = plain(job.pendingQuestion ?? '');
  const has = (type: string) => job.events.some((e) => e.type === type);

  switch (job.status) {
    case 'awaiting_jira_status':
      return {
        ...base,
        kind: 'jira_status',
        question: question || `¿Muevo ${job.ticketKey} a "In Progress" en Jira?`,
        options: [
          { id: 'yes', label: 'Sí, cambiar estado' },
          { id: 'no', label: 'No, dejarlo igual' },
        ],
        freeText: false,
      };
    case 'awaiting_branch':
      return {
        ...base,
        kind: 'branch',
        question: `Selecciona la rama de origen para ${job.ticketKey}.`,
        options: ctx.branches.slice(0, MAX_BRANCH_OPTIONS).map((b) => ({ id: `branch:${b}`, label: b })),
        freeText: true,
      };
    case 'awaiting_repos': {
      const repos = job.triageResult?.repos.map((r) => r.name) ?? [];
      return {
        ...base,
        kind: 'repos',
        question: repos.length ? `El bug parece estar en ${repos.join(', ')}. ¿Confirmo esos repositorios?` : question,
        options: [
          { id: 'confirm', label: 'Confirmar repos' },
          { id: 'reject', label: 'Rechazar' },
        ],
        freeText: false,
      };
    }
    case 'awaiting_clarification':
      if (job.e2eMode === 'awaiting_env') {
        return {
          ...base,
          kind: 'env',
          question: question || `No hay entorno para reproducir ${job.ticketKey}. ¿Sigo solo con código?`,
          options: [
            { id: 'code_only', label: 'Corregir solo con código' },
            { id: 'discard', label: 'Descartar' },
            { id: 'retry', label: 'Reintentar entorno' },
          ],
          freeText: false,
        };
      }
      if (job.regressionTest?.verdict === 'pending') {
        return {
          ...base,
          kind: 'regression',
          question: `El fix de ${job.ticketKey} no trae un spec de regresión verificado. ¿Lo acepto sin spec?`,
          options: [
            { id: 'accept', label: 'Aceptar sin spec' },
            { id: 'discard', label: 'Descartar' },
          ],
          freeText: false,
        };
      }
      return { ...base, kind: 'clarification', question, options: [], freeText: true };
    case 'fixed': {
      const prOpened = job.worktrees.some((w) => w.prUrl && !w.removedAt);
      const prDecided = prOpened || has('pr_opened') || has('pr_skipped');
      if (ctx.prEnabled && job.sourceBranch && !prDecided && job.worktrees.some((w) => !w.removedAt)) {
        return {
          ...base,
          kind: 'pull_request',
          question: `¿Subo la rama y abro el pull request hacia ${job.sourceBranch}?`,
          options: [
            { id: 'open', label: 'Subir y abrir PR' },
            { id: 'skip', label: 'No, lo hago yo' },
          ],
          freeText: false,
        };
      }
      if (prOpened && ctx.jiraMergeStatus && !job.events.some((e) => e.type.startsWith('jira_merge_'))) {
        return {
          ...base,
          kind: 'jira_merge',
          question: `¿Muevo ${job.ticketKey} a "${ctx.jiraMergeStatus}" en Jira?`,
          options: [
            { id: 'transition', label: `Mover a ${ctx.jiraMergeStatus}` },
            { id: 'skip', label: 'Dejar estado' },
          ],
          freeText: false,
        };
      }
      if (ctx.jiraAllowComment && (job.issue || job.solution) && !has('jira_comment') && !has('jira_comment_skipped')) {
        const videos = job.artifacts.filter((a) => a.kind === 'video').length;
        return {
          ...base,
          kind: 'jira_comment',
          question: `¿Publico el reporte en ${job.ticketKey} como comentario${videos ? ` con ${videos} vídeo${videos > 1 ? 's' : ''}` : ''}?`,
          options: [
            { id: 'publish', label: 'Publicar' },
            { id: 'skip', label: 'No publicar' },
          ],
          freeText: false,
        };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
