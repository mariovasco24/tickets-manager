import type { JobDto } from '../shared/job-types.js';

/** Descripción del PR en Markdown (Bitbucket): la misma plantilla QA del hilo y del ticket. */
export function buildPullRequestDescription(job: JobDto): string {
  const lines = ['**Issue:**', job.issue ?? '(not provided)', '', '**Solution:**', job.solution ?? '(not provided)'];
  if (job.notesForQa) lines.push('', '**Notes for QA:**', job.notesForQa);
  if (job.testsResult) lines.push('', `**Tests:** ${job.testsResult}${job.testsDetail ? ` — ${job.testsDetail}` : ''}`);
  if (job.reproduction) lines.push('', `**Reproduction:** ${job.reproduction}`);
  if (job.regressionTest) lines.push('', `**Regression test:** ${job.regressionTest.label}`);
  if (job.filesChanged.length) lines.push('', `**Files (${job.filesChanged.length}):**`, ...job.filesChanged.map((f) => `- \`${f}\``));
  lines.push(
    '',
    `**Jira:** ${job.ticketUrl ? `[${job.ticketKey}](${job.ticketUrl})` : job.ticketKey}`,
    '',
    '_Opened by Bugs Manager after a human confirmation. Review before merging; nothing is merged automatically._',
  );
  return lines.join('\n');
}
