import { copyFile, mkdir, rm, rmdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ticketLogger, logger } from '../logger.js';
import { RunError, lastLines, run } from '../util/exec.js';
import { resolveConfigPath } from '../util/paths.js';

export interface CopyFileSpec {
  /** Ruta absoluta del archivo origen. */
  from: string;
  /** Ruta relativa dentro del worktree. */
  to: string;
}

export interface WorktreeConfig {
  remote: string;
  worktreesDir: string;
  branchPrefix: string;
  installTimeoutMs: number;
}

export interface CreateWorktreeRequest {
  repoName: string;
  repoPath: string;
  ticketKey: string;
  sourceBranch: string;
  /** Rama compartida por todos los worktrees del job (fix/AN-1-<ts>). */
  branch: string;
  /** <WORKTREES_DIR>/<KEY>-<ts>/<repo> */
  worktreePath: string;
  /** undefined = autodetectar por lockfile. */
  installCommand: string | undefined;
  copyFiles: CopyFileSpec[];
}

export interface CreatedWorktree {
  repoName: string;
  branch: string;
  worktreePath: string;
  sourceBranch: string;
  /** Comando que se ejecutó (o null si no había nada que instalar). */
  installCommand: string | null;
  installOutput: string;
  installDurationMs: number;
  copied: string[];
  /** Archivos de COPY_FILES cuyo origen no existía (se avisan, no fallan). */
  skippedCopies: string[];
  /** Archivos que git ya ve modificados tras preparar el worktree (no son cambios del fix). */
  baselineDirty: string[];
}

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly step: 'fetch' | 'worktree_add' | 'copy' | 'install' | 'remove' | 'ls-remote',
    readonly output?: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

const BRANCH_CACHE_MS = 60_000;
const GIT_TIMEOUT_MS = 120_000;

/**
 * Gestiona worktrees git para los jobs, en cualquier repo del catálogo. Un job
 * tiene un directorio <WORKTREES_DIR>/<KEY>-<ts>/ con un worktree por repo,
 * todos en la misma rama fix/<KEY>-<ts> creada desde la misma rama origen.
 * Nunca hace commit, push ni merge.
 */
export class WorktreeManager {
  private readonly branchCache = new Map<string, { at: number; branches: string[] }>();

  constructor(private readonly cfg: WorktreeConfig) {}

  get remoteName(): string {
    return this.cfg.remote;
  }

  async check(): Promise<string[]> {
    const problems: string[] = [];
    try {
      await mkdir(this.cfg.worktreesDir, { recursive: true });
    } catch (err) {
      problems.push(`No se pudo crear WORKTREES_DIR (${this.cfg.worktreesDir}): ${(err as Error).message}`);
    }
    return problems;
  }

  /** Comprueba que un clon existe y tiene el remoto configurado. */
  async checkRepo(repoPath: string): Promise<string | undefined> {
    try {
      await run('git', ['rev-parse', '--git-dir'], { cwd: repoPath, timeoutMs: 10_000 });
    } catch (err) {
      return `${repoPath} no es un repositorio git: ${(err as Error).message}`;
    }
    try {
      await run('git', ['remote', 'get-url', this.cfg.remote], { cwd: repoPath, timeoutMs: 10_000 });
    } catch {
      return `El remoto ${this.cfg.remote} no existe en ${repoPath}`;
    }
    return undefined;
  }

  /** Ramas del remoto de un repo, ordenadas con develop/main/release primero. Cache de 60 s por repo. */
  async listRemoteBranches(repoPath: string, force = false): Promise<string[]> {
    const cached = this.branchCache.get(repoPath);
    if (!force && cached && Date.now() - cached.at < BRANCH_CACHE_MS) return cached.branches;
    let res;
    try {
      // Sin un límite amplio se perderían ramas en silencio: un repo grande pasa de 120 KB.
      res = await run('git', ['ls-remote', '--heads', this.cfg.remote], {
        cwd: repoPath,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutput: 32 * 1024 * 1024,
      });
    } catch (err) {
      throw new WorktreeError(`No se pudieron listar las ramas de ${this.cfg.remote} en ${repoPath}: ${(err as Error).message}`, 'ls-remote', outputOf(err));
    }
    if (res.truncated) {
      logger().error({ repoPath }, 'La lista de ramas del remoto llegó truncada: faltarían ramas. Sube maxOutput.');
    }
    const branches = res.stdout
      .split('\n')
      .map((l) => l.split('\t')[1] ?? '')
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort(compareBranches);
    this.branchCache.set(repoPath, { at: Date.now(), branches });
    return branches;
  }

  async branchExistsOnRemote(repoPath: string, branch: string): Promise<boolean> {
    if ((await this.listRemoteBranches(repoPath)).includes(branch)) return true;
    return (await this.listRemoteBranches(repoPath, true)).includes(branch);
  }

  /** Nombres únicos para un job: rama compartida y directorio raíz de sus worktrees. */
  namesFor(ticketKey: string, now = new Date()): { branch: string; jobDir: string; slug: string } {
    const slug = `${ticketKey}-${timestamp(now)}`;
    return { slug, branch: `${this.cfg.branchPrefix}${slug}`, jobDir: path.join(this.cfg.worktreesDir, slug) };
  }

  /** Ruta del worktree de un repo dentro del directorio del job. */
  worktreePathFor(jobDir: string, repoName: string): string {
    return path.join(jobDir, repoName);
  }

  /**
   * fetch → worktree add -b → copiar archivos → instalar dependencias.
   * Si algo falla después de crear el worktree, lo elimina para no dejar basura.
   */
  async create(req: CreateWorktreeRequest): Promise<CreatedWorktree> {
    const log = ticketLogger(req.ticketKey, { component: 'worktree', repo: req.repoName });
    const { remote } = this.cfg;

    log.info({ sourceBranch: req.sourceBranch, remote }, 'git fetch');
    try {
      await run('git', ['fetch', '--no-tags', remote, req.sourceBranch], { cwd: req.repoPath, timeoutMs: GIT_TIMEOUT_MS });
    } catch (err) {
      throw new WorktreeError(`git fetch ${remote} ${req.sourceBranch} falló en ${req.repoName}: ${(err as Error).message}`, 'fetch', outputOf(err));
    }

    await mkdir(path.dirname(req.worktreePath), { recursive: true });
    log.info({ branch: req.branch, worktreePath: req.worktreePath }, 'git worktree add');
    try {
      await run('git', ['worktree', 'add', req.worktreePath, '-b', req.branch, `${remote}/${req.sourceBranch}`], {
        cwd: req.repoPath,
        timeoutMs: GIT_TIMEOUT_MS,
      });
    } catch (err) {
      throw new WorktreeError(`git worktree add falló en ${req.repoName}: ${(err as Error).message}`, 'worktree_add', outputOf(err));
    }

    try {
      const { copied, skipped } = await this.copyFiles(req.worktreePath, req.copyFiles);
      if (copied.length) log.info({ copied }, 'Archivos copiados al worktree');
      if (skipped.length) log.warn({ skipped }, 'Orígenes de COPY_FILES inexistentes; se omiten');

      const installCommand = req.installCommand ?? detectInstallCommand(req.worktreePath);
      let installOutput = '';
      let installDurationMs = 0;
      if (installCommand) {
        log.info({ command: installCommand }, 'Instalando dependencias');
        try {
          const res = await run(installCommand, [], { cwd: req.worktreePath, shell: true, timeoutMs: this.cfg.installTimeoutMs });
          installOutput = lastLines(res.output, 10);
          installDurationMs = res.durationMs;
          log.info({ durationMs: res.durationMs }, 'Dependencias instaladas');
        } catch (err) {
          throw new WorktreeError(`La instalación de dependencias falló en ${req.repoName}: ${(err as Error).message}`, 'install', outputOf(err));
        }
      } else {
        log.info('Sin comando de instalación (no hay package.json ni INSTALL_COMMAND)');
      }

      // Lo que git ya ve sucio tras preparar el worktree (lockfile regenerado, .env copiado…)
      // no es obra de Claude: se guarda para descontarlo del reporte de archivos cambiados.
      const baselineDirty = await this.dirtyFiles(req.worktreePath);

      return {
        repoName: req.repoName,
        branch: req.branch,
        worktreePath: req.worktreePath,
        sourceBranch: req.sourceBranch,
        installCommand: installCommand ?? null,
        installOutput,
        installDurationMs,
        copied,
        skippedCopies: skipped,
        baselineDirty,
      };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Fallo tras crear el worktree; se elimina');
      await this.remove(req.repoPath, req.worktreePath, req.branch).catch((e: unknown) =>
        log.error({ err: (e as Error).message }, 'No se pudo limpiar el worktree fallido'),
      );
      throw err;
    }
  }

  /** Elimina el worktree (y su rama local si `branch` viene). No toca el remoto. */
  async remove(repoPath: string, worktreePath: string, branch?: string | null): Promise<void> {
    try {
      await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS });
    } catch (err) {
      const msg = (err as Error).message;
      if (!/is not a working tree|No such file|does not exist|not a git repository/i.test(msg + (outputOf(err) ?? ''))) {
        throw new WorktreeError(`git worktree remove falló: ${msg}`, 'remove', outputOf(err));
      }
      await rm(worktreePath, { recursive: true, force: true });
    }
    await run('git', ['worktree', 'prune'], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);
    if (branch) {
      await run('git', ['branch', '-D', branch], { cwd: repoPath, timeoutMs: GIT_TIMEOUT_MS }).catch((err: unknown) =>
        logger().debug({ branch, err: (err as Error).message }, 'No se pudo borrar la rama local (quizá ya no existe)'),
      );
    }
    // Si el directorio del job quedó vacío, se elimina también (rmdir falla si aún tiene worktrees).
    const jobDir = path.dirname(worktreePath);
    if (jobDir.startsWith(this.cfg.worktreesDir) && jobDir !== this.cfg.worktreesDir) await rmdir(jobDir).catch(() => undefined);
  }

  /** Archivos modificados o nuevos según git status --porcelain (rutas relativas al worktree). */
  async dirtyFiles(worktreePath: string): Promise<string[]> {
    try {
      const res = await run('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: worktreePath,
        timeoutMs: 30_000,
        maxOutput: 8 * 1024 * 1024,
      });
      return parsePorcelain(res.stdout);
    } catch {
      return [];
    }
  }

  private async copyFiles(worktreePath: string, specs: CopyFileSpec[]): Promise<{ copied: string[]; skipped: string[] }> {
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const spec of specs) {
      const dest = path.resolve(worktreePath, spec.to);
      if (!dest.startsWith(worktreePath + path.sep)) {
        throw new WorktreeError(`COPY_FILES: el destino ${spec.to} sale del worktree`, 'copy');
      }
      try {
        await stat(spec.from);
      } catch {
        skipped.push(spec.from);
        continue;
      }
      try {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(spec.from, dest);
        copied.push(spec.to);
      } catch (err) {
        throw new WorktreeError(`No se pudo copiar ${spec.from} → ${spec.to}: ${(err as Error).message}`, 'copy');
      }
    }
    return { copied, skipped };
  }
}

/** package-lock.json → npm ci; package.json → npm install; nada → sin instalación. */
export function detectInstallCommand(dir: string): string | undefined {
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm ci';
  if (existsSync(path.join(dir, 'package.json'))) return 'npm install';
  return undefined;
}

/** "COPY_FILES=/a/.env.tpl:.env,/b/x.json:config/x.json" → specs. Sin destino, usa el nombre del origen en la raíz. */
export function parseCopyFiles(value: string | undefined, baseDir: string): CopyFileSpec[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.lastIndexOf(':');
      const from = idx > 0 ? pair.slice(0, idx).trim() : pair;
      const to = idx > 0 ? pair.slice(idx + 1).trim() : path.basename(from).replace(/\.(template|tpl|example|sample)$/i, '');
      return { from: resolveConfigPath(from, baseDir), to };
    });
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const PRIORITY = ['develop', 'development', 'main', 'master', 'production'];

/** Versión numérica de una rama de release/patch/dev, para ordenar 9.6 por encima de 9.5. */
function versionOf(branch: string): number[] | undefined {
  // El número debe ir justo tras el prefijo: "release/9.6" sí, "release/RCDEC2021" no.
  const m = /^(?:release|patch)\/(\d+(?:\.\d+)*)|^dev\/release\.(\d+(?:\.\d+)*)/.exec(branch);
  const v = m?.[1] ?? m?.[2];
  return v ? v.split('.').map(Number) : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0); // descendente: la más nueva primero
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Orden del desplegable: primero las ramas troncales, después las de release y
 * dev/release por versión descendente (9.6 antes que 9.5), y al final el resto
 * alfabéticamente. Las release sin versión reconocible van tras las versionadas.
 */
function compareBranches(a: string, b: string): number {
  const pa = PRIORITY.indexOf(a);
  const pb = PRIORITY.indexOf(b);
  if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);

  const va = versionOf(a);
  const vb = versionOf(b);
  if (va && vb) return compareVersions(va, vb) || a.localeCompare(b);
  if (va) return -1;
  if (vb) return 1;

  const ra = /^(release|patch)\//.test(a);
  const rb = /^(release|patch)\//.test(b);
  if (ra !== rb) return ra ? -1 : 1;
  return a.localeCompare(b);
}

/**
 * Parsea la salida de `git status --porcelain`. Cada línea es "XY ruta" (dos códigos de
 * estado y un espacio). No se puede cortar por posición fija: `run()` recorta la salida
 * y la primera línea puede haber perdido su espacio inicial (" M src/…" → "M src/…").
 */
export function parsePorcelain(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*([MADRCU?!]{1,2})\s+(.+)$/.exec(line);
    if (!m?.[2]) continue;
    const p = m[2].trim();
    out.push(p.includes(' -> ') ? p.split(' -> ')[1]! : p);
  }
  return out;
}

function outputOf(err: unknown): string | undefined {
  return err instanceof RunError ? err.result?.output : undefined;
}
