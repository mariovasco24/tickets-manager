import { RunError, lastLines, run } from '../util/exec.js';

const GIT_TIMEOUT_MS = 120_000;
/** Los hooks del repo (lint-staged con tsc/eslint/prettier, commitlint) pueden tardar. */
const COMMIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Publicación de la rama de un worktree: commit de los cambios, push con su MISMO
 * nombre y nada más. La rama origen nunca se toca desde aquí: llega por PR.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly step: 'stage' | 'commit' | 'push' | 'inspect',
    readonly output?: string,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

/**
 * Cabecera del commit y título del PR a partir de la plantilla ({key}, {summary}).
 * El título del ticket va con la primera letra en minúscula (config-conventional
 * rechaza sentence-case) y la cabecera se recorta a 100 caracteres (header-max-length)
 * cortando en una palabra.
 */
export function commitHeader(template: string, key: string, summary: string, max = 100): string {
  const clean = summary.replace(/\s+/g, ' ').trim();
  const subject = clean ? clean.charAt(0).toLowerCase() + clean.slice(1) : `resolve ${key}`;
  const render = (s: string) => template.replace(/\{key\}/g, key).replace(/\{summary\}/g, s);
  const full = render(subject);
  if (full.length <= max) return full;
  const room = max - (full.length - subject.length) - 1; // hueco para "…"
  let cut = subject.slice(0, Math.max(room, 10));
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace);
  return render(`${cut.trimEnd()}…`);
}

/** Añade exactamente esos archivos (relativos al worktree) y commitea pasando por los hooks del repo. */
export async function stageAndCommit(worktreePath: string, files: string[], message: string): Promise<{ sha: string }> {
  if (!files.length) throw new PublishError('no hay archivos que commitear', 'stage');
  try {
    await run('git', ['add', '-A', '--', ...files], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS });
  } catch (err) {
    throw new PublishError(`git add falló: ${describe(err)}`, 'stage', outputOf(err));
  }
  try {
    await run('git', ['commit', '--quiet', '-m', message], { cwd: worktreePath, timeoutMs: COMMIT_TIMEOUT_MS, maxOutput: 1024 * 1024 });
  } catch (err) {
    throw new PublishError(`git commit falló (revisa la salida: suelen ser los hooks del repo, lint-staged o commitlint): ${describe(err)}`, 'commit', outputOf(err));
  }
  return { sha: await headSha(worktreePath) };
}

export async function headSha(worktreePath: string): Promise<string> {
  const r = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS });
  return r.stdout.trim();
}

/** Commits de la rama que no están en <remote>/<source>: lo que iría al PR. */
export async function commitsAhead(worktreePath: string, remote: string, sourceBranch: string): Promise<number> {
  try {
    const r = await run('git', ['rev-list', '--count', `${remote}/${sourceBranch}..HEAD`], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS });
    return Number(r.stdout.trim()) || 0;
  } catch (err) {
    throw new PublishError(`no pude comparar con ${remote}/${sourceBranch}: ${describe(err)}`, 'inspect', outputOf(err));
  }
}

/**
 * Sube la rama a una ref con su MISMO nombre y la deja como upstream (así un
 * `git push` manual posterior tampoco va a la rama origen). Nunca a otra ref.
 */
export async function pushBranch(worktreePath: string, remote: string, branch: string): Promise<void> {
  try {
    await run('git', ['push', '--set-upstream', remote, `${branch}:refs/heads/${branch}`], {
      cwd: worktreePath,
      timeoutMs: COMMIT_TIMEOUT_MS,
      maxOutput: 1024 * 1024,
    });
  } catch (err) {
    throw new PublishError(`git push falló: ${describe(err)}`, 'push', outputOf(err));
  }
}

export async function remoteUrl(worktreePath: string, remote: string): Promise<string> {
  const r = await run('git', ['remote', 'get-url', remote], { cwd: worktreePath, timeoutMs: GIT_TIMEOUT_MS });
  return r.stdout.trim();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function outputOf(err: unknown): string | undefined {
  return err instanceof RunError && err.result ? lastLines(err.result.output, 20) : undefined;
}
