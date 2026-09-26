import type { Config } from '../config.js';
import type { JiraComment, JiraIssue } from '../types.js';

const CLOSED_STATUS_NAMES = new Set(['done', 'closed', 'cerrado', 'resuelto', 'resolved']);

/**
 * Cliente mínimo de la API REST v3 de Jira Cloud. Lectura para el contexto del
 * bug y una ÚNICA escritura posible: mover el ticket a "en curso" al empezar, y
 * solo cuando una persona lo confirma. Nunca comenta ni edita campos.
 */
export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  /** Se rellena si whoAmI() falló al arrancar, para explicar mejor los 404 posteriores. */
  private authProblem: string | undefined;

  constructor(cfg: Pick<Config, 'JIRA_BASE_URL' | 'JIRA_EMAIL' | 'JIRA_API_TOKEN'>) {
    this.baseUrl = cfg.JIRA_BASE_URL.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${cfg.JIRA_EMAIL}:${cfg.JIRA_API_TOKEN}`).toString('base64')}`;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const fields = ['summary', 'description', 'status', 'issuetype', 'project', 'reporter', 'comment'].join(',');
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (res.status === 404) {
      // Jira responde 404 (no 401) a peticiones mal autenticadas: si el arranque ya detectó
      // credenciales inválidas, lo decimos claro en vez de culpar al ticket.
      const hint = this.authProblem ? ` (${this.authProblem})` : '';
      throw new JiraError(`El ticket ${key} no existe o no tienes acceso${hint}`, 404);
    }
    if (res.status === 401 || res.status === 403) {
      throw new JiraError(`Jira rechazó las credenciales (${res.status}): revisa JIRA_EMAIL / JIRA_API_TOKEN`, res.status);
    }
    if (!res.ok) throw new JiraError(`Jira respondió ${res.status} al leer ${key}: ${await res.text()}`, res.status);

    const data = (await res.json()) as JiraIssueResponse;
    const f = data.fields;
    return {
      key: data.key,
      summary: f.summary ?? '',
      description: adfToText(f.description),
      status: f.status?.name ?? 'unknown',
      statusCategory: f.status?.statusCategory?.key ?? 'unknown',
      issueType: f.issuetype?.name ?? 'unknown',
      projectKey: f.project?.key ?? data.key.split('-')[0] ?? '',
      reporter: f.reporter?.displayName ?? 'desconocido',
      url: this.issueUrl(data.key),
      comments: (f.comment?.comments ?? []).map(
        (c): JiraComment => ({
          author: c.author?.displayName ?? 'desconocido',
          created: c.created,
          body: adfToText(c.body),
        }),
      ),
    };
  }

  /** Transiciones disponibles ahora mismo para el ticket (depende de su estado y de tus permisos). */
  async getTransitions(key: string): Promise<Array<{ id: string; name: string; to: string }>> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!res.ok) throw new JiraError(`Jira respondió ${res.status} al listar transiciones de ${key}`, res.status);
    const data = (await res.json()) as { transitions?: Array<{ id: string; name: string; to?: { name?: string } }> };
    return (data.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? '' }));
  }

  /**
   * Aplica una transición. Es la ÚNICA escritura que este servicio hace en Jira, y
   * solo después de que una persona la confirme en el hilo o en el dashboard.
   */
  async transition(key: string, transitionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (res.status === 403 || res.status === 401) {
      throw new JiraError(`tu cuenta no tiene permiso para transicionar ${key} (${res.status})`, res.status);
    }
    if (!res.ok) throw new JiraError(`Jira respondió ${res.status} al transicionar ${key}: ${await res.text()}`, res.status);
  }

  /** Adjunta un archivo al ticket. Devuelve el id del adjunto para poder incrustarlo. */
  async addAttachment(key: string, filePath: string): Promise<{ id: string; filename: string; url: string }> {
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const buf = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)]), basename(filePath));
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
      body: form,
    });
    if (!res.ok) throw new JiraError(`Jira respondió ${res.status} al adjuntar ${basename(filePath)}: ${await res.text()}`, res.status);
    const data = (await res.json()) as Array<{ id?: string; filename?: string; content?: string }>;
    const first = data[0];
    if (!first?.id) throw new JiraError(`Jira no devolvió el adjunto de ${basename(filePath)}`, 500);
    return { id: first.id, filename: first.filename ?? basename(filePath), url: first.content ?? '' };
  }

  /** Publica un comentario en formato ADF. Requiere confirmación humana aguas arriba. */
  async addComment(key: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      headers: { Authorization: this.authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new JiraError(`Jira respondió ${res.status} al comentar ${key}: ${(await res.text()).slice(0, 300)}`, res.status);
  }

  issueUrl(key: string): string {
    return `${this.baseUrl}/browse/${key}`;
  }

  /** Valida credenciales al arrancar. */
  async whoAmI(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/myself`, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!res.ok) {
      this.authProblem = `las credenciales de Jira fallaron al arrancar con ${res.status}: revisa JIRA_EMAIL / JIRA_API_TOKEN`;
      throw new JiraError(`Jira rechazó las credenciales (${res.status})`, res.status);
    }
    this.authProblem = undefined;
    const me = (await res.json()) as { displayName?: string; emailAddress?: string };
    return me.displayName ?? me.emailAddress ?? 'ok';
  }

  static isClosed(issue: Pick<JiraIssue, 'status' | 'statusCategory'>): boolean {
    return issue.statusCategory === 'done' || CLOSED_STATUS_NAMES.has(issue.status.toLowerCase());
  }
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

// ---- Atlassian Document Format → texto plano -------------------------------

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

/** Convierte ADF (formato de descripción/comentarios en API v3) a texto legible. */
export function adfToText(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  return render(node).replace(/\n{3,}/g, '\n\n').trim();
}

function render(node: AdfNode, depth = 0): string {
  const children = () => (node.content ?? []).map((c) => render(c, depth + 1)).join('');
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return `@${String(node.attrs?.text ?? node.attrs?.id ?? '')}`.replace('@@', '@');
    case 'emoji':
      return String(node.attrs?.shortName ?? '');
    case 'inlineCard':
      return String(node.attrs?.url ?? '');
    case 'paragraph':
      return `${children()}\n`;
    case 'heading':
      return `\n${'#'.repeat(Number(node.attrs?.level ?? 1))} ${children()}\n`;
    case 'codeBlock':
      return `\n\`\`\`${String(node.attrs?.language ?? '')}\n${children()}\n\`\`\`\n`;
    case 'blockquote':
      return children()
        .split('\n')
        .map((l) => (l ? `> ${l}` : l))
        .join('\n');
    case 'listItem':
      return `- ${children().trimEnd()}\n`;
    case 'bulletList':
    case 'orderedList':
      return `${children()}\n`;
    case 'rule':
      return '\n---\n';
    case 'table':
      return `${children()}\n`;
    case 'tableRow':
      return `| ${(node.content ?? []).map((c) => render(c, depth + 1).trim()).join(' | ')} |\n`;
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '[adjunto]\n';
    default:
      return children();
  }
}

interface JiraIssueResponse {
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | null;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    project?: { key?: string };
    reporter?: { displayName?: string };
    comment?: { comments?: Array<{ author?: { displayName?: string }; created: string; body?: AdfNode }> };
  };
}
