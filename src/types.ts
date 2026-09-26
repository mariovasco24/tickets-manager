export type TriggerSource = 'webhook' | 'manual';

/**
 * Objeto común al que convergen los dos disparadores (webhook de Jira y
 * mención / slash command de Slack). En la fase 2 se convertirá en un Job
 * persistido; por ahora solo abre el hilo.
 */
export interface IncomingBug {
  key: string;
  source: TriggerSource;
  /** Texto legible de quién lo pidió (nombre en Jira o <@Uxxx> en Slack). */
  requestedBy: string;
  /** Rama origen indicada de antemano ("/fix AN-1 desde develop"). */
  sourceBranch?: string;
  /** Contexto adicional del equipo ("/fix AN-1: ten en cuenta el componente X"). */
  notes?: string;
}

export interface JiraComment {
  author: string;
  created: string;
  body: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  /** 'new' | 'indeterminate' | 'done' según Jira. */
  statusCategory: string;
  issueType: string;
  projectKey: string;
  reporter: string;
  url: string;
  comments: JiraComment[];
}

export interface ThreadRef {
  channel: string;
  ts: string;
}
