import { isAwaiting, type JobDto } from '../../../src/shared/job-types';
import { formatDate, formatDuration, relative } from '../format';
import { CopyButton } from './CopyButton';
import { StatusBadge } from './StatusBadge';

interface Props {
  job: JobDto;
  now: number;
  expanded: boolean;
  onToggle: () => void;
}

export function JobRow({ job, now, expanded, onToggle }: Props) {
  const awaiting = isAwaiting(job.status);
  return (
    <div className={`row ${awaiting ? 'row-awaiting' : ''} ${expanded ? 'row-expanded' : ''}`}>
      <button type="button" className="row-main" onClick={onToggle} aria-expanded={expanded}>
        <span className="chev">{expanded ? '▾' : '▸'}</span>
        <span className="col-key">
          {job.ticketUrl ? (
            <a href={job.ticketUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {job.ticketKey}
            </a>
          ) : (
            job.ticketKey
          )}
        </span>
        <span className="col-title" title={job.ticketSummary ?? ''}>
          {job.ticketSummary ?? <em>sin título</em>}
        </span>
        <span className="col-status">
          <StatusBadge status={job.status} />
        </span>
        <span className="col-branches">
          <span className="mono" title="Rama origen">
            {job.sourceBranch ?? '—'}
          </span>
          <span className="arrow">→</span>
          <span className="mono" title="Rama creada">
            {job.branch ?? '—'}
          </span>
        </span>
        <span className="col-origin" title={`Solicitado por ${job.requestedBy}`}>
          {job.source === 'webhook' ? 'webhook' : job.source === 'voice' ? 'voz' : 'manual'} · {job.requestedBy.replace(/^<@|>$/g, '')}
        </span>
        <span className="col-time" title={`Creado ${formatDate(job.createdAt)} · Actualizado ${formatDate(job.updatedAt)}`}>
          <span>{formatDate(job.createdAt)}</span>
          <span className="muted">
            {relative(job.updatedAt, now)} · {formatDuration(job.createdAt, job.finishedAt, now)}
          </span>
        </span>
      </button>

      {awaiting && job.pendingQuestion && !expanded && (
        <div className="pending-inline">
          <strong>Pregunta pendiente:</strong> {job.pendingQuestion}
          <button type="button" className="btn btn-small" onClick={onToggle}>
            Responder
          </button>
        </div>
      )}

      {job.worktreePath && !expanded && (
        <div className="worktree-inline">
          <span className="mono">{job.worktreePath}</span>
          <CopyButton text={job.worktreePath} />
        </div>
      )}
    </div>
  );
}
