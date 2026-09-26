import type { JobDetailDto, JobDto, JobMessageDto, JobStatus, MetaDto } from '../../src/shared/job-types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* sin cuerpo JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  meta: () => request<MetaDto>('/api/meta'),
  jobs: () => request<JobDto[]>('/api/jobs'),
  job: (id: string) => request<JobDetailDto>(`/api/jobs/${encodeURIComponent(id)}`),
  answer: (id: string, answer: string) =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  message: (id: string, answer: string) =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/message`, { method: 'POST', body: JSON.stringify({ answer }) }),
  discard: (id: string, reason?: string) =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/discard`, { method: 'POST', body: JSON.stringify({ reason }) }),
  messages: (id: string, after = 0) => request<JobMessageDto[]>(`/api/jobs/${encodeURIComponent(id)}/messages?after=${after}`),
  branches: () => request<string[]>('/api/branches'),
  repos: () => request<Array<{ name: string; cloned: boolean; catalogProfile: boolean }>>('/api/repos'),
  jiraComment: (id: string, action: 'publish' | 'skip') =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/jira-comment`, { method: 'POST', body: JSON.stringify({ action }) }),
  jiraDecision: (id: string, action: 'transition' | 'skip') =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/jira`, { method: 'POST', body: JSON.stringify({ action }) }),
  regressionDecision: (id: string, action: 'accept' | 'discard') =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/regression`, { method: 'POST', body: JSON.stringify({ action }) }),
  pullRequest: (id: string, action: 'open' | 'skip') =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/pull-request`, { method: 'POST', body: JSON.stringify({ action }) }),
  jiraMerge: (id: string, action: 'transition' | 'skip') =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/jira-merge`, { method: 'POST', body: JSON.stringify({ action }) }),
  envDecision: (id: string, action: 'code_only' | 'discard' | 'retry') =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/env`, { method: 'POST', body: JSON.stringify({ action }) }),
  confirmRepos: (id: string, repos?: string[]) =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/repos`, { method: 'POST', body: JSON.stringify({ action: 'confirm', repos }) }),
  rejectRepos: (id: string) =>
    request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/repos`, { method: 'POST', body: JSON.stringify({ action: 'reject' }) }),
  removeWorktree: (id: string) => request<JobDto>(`/api/jobs/${encodeURIComponent(id)}/worktree`, { method: 'DELETE' }),
  cleanupWorktrees: () =>
    request<{ removed: string[]; errors: Array<{ ticketKey: string; error: string }> }>('/api/worktrees/cleanup', {
      method: 'POST',
      body: '{}',
    }),
  devSetStatus: (id: string, status: JobStatus, question?: string) =>
    request<JobDto>(`/api/dev/jobs/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, question }),
    }),
};
