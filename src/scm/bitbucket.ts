/**
 * Cliente mínimo de Bitbucket Cloud para abrir pull requests. Es la única
 * operación: nunca mergea, nunca cierra, nunca toca la rama destino.
 * Auth: Basic con email de la cuenta Atlassian + token de API (por defecto los
 * mismos de Jira, misma cuenta).
 */
export interface BitbucketRepo {
  workspace: string;
  slug: string;
}

export interface PullRequestRef {
  id: number;
  url: string;
  title: string;
  destination: string;
}

export interface BitbucketConfig {
  apiBase: string;
  email: string;
  token: string;
}

/** git@bitbucket.org:ws/slug.git · ssh://git@bitbucket.org/ws/slug.git · https://[user@]bitbucket.org/ws/slug[.git] */
export function parseBitbucketRemote(url: string): BitbucketRepo | undefined {
  const m = /bitbucket\.org[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { workspace: m[1]!, slug: m[2]! } : undefined;
}

export class BitbucketClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(cfg: BitbucketConfig) {
    this.base = cfg.apiBase.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`;
  }

  /** PR abierto desde esa rama, si ya existe (p. ej. lo creó alguien a mano): se reutiliza en vez de duplicar. */
  async findOpenPullRequest(repo: BitbucketRepo, sourceBranch: string): Promise<PullRequestRef | undefined> {
    const q = encodeURIComponent(`source.branch.name = "${sourceBranch}" AND state = "OPEN"`);
    const res = await fetch(`${this.base}/repositories/${repo.workspace}/${repo.slug}/pullrequests?q=${q}&pagelen=5`, { headers: this.headers() });
    if (res.status === 404) return undefined; // sin acceso o slug distinto: lo dirá el create con más detalle
    if (res.status === 401 || res.status === 403) throw new BitbucketError(await credentialsHint(res, repo), res.status);
    if (!res.ok) throw new BitbucketError(`Bitbucket respondió ${res.status} al buscar PRs de ${sourceBranch}: ${(await res.text()).slice(0, 300)}`, res.status);
    const data = (await res.json()) as { values?: PrPayload[] };
    const hit = data.values?.[0];
    return hit ? toRef(hit) : undefined;
  }

  async createPullRequest(
    repo: BitbucketRepo,
    input: { title: string; description: string; sourceBranch: string; destinationBranch: string; closeSourceBranch: boolean },
  ): Promise<PullRequestRef> {
    const res = await fetch(`${this.base}/repositories/${repo.workspace}/${repo.slug}/pullrequests`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        source: { branch: { name: input.sourceBranch } },
        destination: { branch: { name: input.destinationBranch } },
        close_source_branch: input.closeSourceBranch,
      }),
    });
    if (res.status === 401 || res.status === 403) throw new BitbucketError(await credentialsHint(res, repo), res.status);
    if (!res.ok) throw new BitbucketError(`Bitbucket respondió ${res.status} al crear el PR en ${repo.workspace}/${repo.slug}: ${(await res.text()).slice(0, 300)}`, res.status);
    return toRef((await res.json()) as PrPayload);
  }

  private headers(): Record<string, string> {
    return { Authorization: this.auth, Accept: 'application/json' };
  }
}

/**
 * Mensaje accionable para un 401/403. Caso real: el token de Jira funciona en Jira pero Bitbucket
 * responde "API Token provided has no Bitbucket scopes": hace falta un token CON ámbitos de Bitbucket.
 */
async function credentialsHint(res: Response, repo: BitbucketRepo): Promise<string> {
  let detail = '';
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    detail = data.error?.message ?? '';
  } catch {
    /* sin cuerpo JSON */
  }
  const noScopes = /no Bitbucket scopes/i.test(detail);
  return [
    `Bitbucket rechazó las credenciales (${res.status}${detail ? `: ${detail}` : ''}).`,
    noScopes
      ? 'El token de API que usa el servicio (por defecto el de Jira) no tiene ámbitos de Bitbucket.'
      : `Revisa BITBUCKET_EMAIL / BITBUCKET_API_TOKEN y el acceso a ${repo.workspace}/${repo.slug}.`,
    'Solución: en id.atlassian.com → Seguridad → Tokens de API → "Crear token de API con ámbitos", producto Bitbucket, ámbitos read:repository:bitbucket, read:pullrequest:bitbucket y write:pullrequest:bitbucket; ponlo en BITBUCKET_API_TOKEN (y BITBUCKET_EMAIL si es otra cuenta), reinicia el servicio y pulsa "Subir rama y abrir PR" otra vez.',
  ].join(' ');
}

interface PrPayload {
  id: number;
  title?: string;
  links?: { html?: { href?: string } };
  destination?: { branch?: { name?: string } };
}

function toRef(p: PrPayload): PullRequestRef {
  return { id: p.id, url: p.links?.html?.href ?? '', title: p.title ?? '', destination: p.destination?.branch?.name ?? '' };
}

export class BitbucketError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BitbucketError';
  }
}
