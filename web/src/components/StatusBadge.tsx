import { STATUS_LABELS, type JobStatus } from '../../../src/shared/job-types';

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`badge status-${status}`} title={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}
