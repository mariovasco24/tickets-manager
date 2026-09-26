import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseCopyFiles, type CopyFileSpec } from '../git/worktree.js';
import { logger } from '../logger.js';
import { RunError, run } from '../util/exec.js';

export interface RepoOverrides {
  installCommand?: string;
  testCommand?: string;
  copyFiles?: string;
  /** Cómo arrancar la app para reproducir en navegador; vacío = detectar por package.json. */
  devCommand?: string;
  /** Carpeta servida donde dejar el harness de embebido; vacío = detectar. */
  harnessDir?: string;
}

export interface RepoInfo {
  /** Nombre canónico tal como aparece en el manifest (p. ej. analytiq_widget). */
  name: string;
  /** URL explícita del manifest, si la hay. */
  cloneUrl?: string;
  /** <REPOS_DIR>/<name> */
  localPath: string;
  cloned: boolean;
  /** Perfil del catálogo en el repo de conocimiento, si existe. */
  catalogProfile?: string;
}

export interface RepoSettings {
  /** undefined = autodetectar en el worktree. */
  installCommand: string | undefined;
  testCommand: string | undefined;
  copyFiles: CopyFileSpec[];
  devCommand: string | undefined;
  harnessDir: string | undefined;
}

export interface RegistryConfig {
  knowledgePath: string;
  reposDir: string;
  manifestPath: string;
  /** Globales; los overrides por repo tienen prioridad. */
  installCommand: string | undefined;
  testCommand: string | undefined;
  copyFiles: string | undefined;
  overrides: Map<string, RepoOverrides>;
  cloneTimeoutMs: number;
  /** Base para resolver rutas relativas en COPY_FILES. */
  baseDir: string;
}

export class RepoRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoRegistryError';
  }
}

/**
 * Catálogo de repositorios de producto: nombres del manifest de
 * qrvey_platform_knowledge, clones locales bajo repos_product/, clonado bajo
 * demanda a través de scripts/setup.sh (nunca git clone a mano) y ajustes por
 * repo (instalación, tests, archivos a copiar).
 */
export class RepoRegistry {
  private manifest: Array<{ name: string; cloneUrl?: string }> = [];

  constructor(private readonly cfg: RegistryConfig) {
    this.reload();
  }

  get knowledgePath(): string {
    return this.cfg.knowledgePath;
  }

  get reposDir(): string {
    return this.cfg.reposDir;
  }

  reload(): void {
    this.manifest = parseManifest(this.cfg.manifestPath);
  }

  /** Overrides por repo (REPO_<NOMBRE>_*), asociados a nombres canónicos. */
  setOverrides(overrides: Map<string, RepoOverrides>): void {
    this.cfg.overrides.clear();
    for (const [k, v] of overrides) this.cfg.overrides.set(k, v);
  }

  /** Comprueba al arrancar que el repo de conocimiento, el manifest y repos_product existen. */
  async check(): Promise<string[]> {
    const problems: string[] = [];
    if (!existsSync(path.join(this.cfg.knowledgePath, 'AGENTS.md'))) {
      problems.push(`KNOWLEDGE_REPO_PATH (${this.cfg.knowledgePath}) no parece el clon de qrvey_platform_knowledge (falta AGENTS.md)`);
    }
    if (!existsSync(this.cfg.manifestPath)) {
      problems.push(`No existe el manifest de repos: ${this.cfg.manifestPath}`);
    } else if (this.manifest.length === 0) {
      problems.push(`El manifest ${this.cfg.manifestPath} no declara ningún repo`);
    }
    if (!existsSync(path.join(this.cfg.knowledgePath, 'scripts', 'setup.sh'))) {
      problems.push('Falta scripts/setup.sh en el repo de conocimiento: no se podrán clonar repos bajo demanda');
    }
    try {
      await mkdir(this.cfg.reposDir, { recursive: true });
    } catch (err) {
      problems.push(`No se pudo crear REPOS_DIR (${this.cfg.reposDir}): ${(err as Error).message}`);
    }
    for (const [name] of this.cfg.overrides) {
      if (!this.has(name)) problems.push(`Override REPO_${envKey(name)}_* para un repo que no está en el manifest: ${name}`);
    }
    return problems;
  }

  names(): string[] {
    return this.manifest.map((m) => m.name);
  }

  has(name: string): boolean {
    return this.manifest.some((m) => m.name === name);
  }

  /** Resuelve un nombre escrito a mano (mayúsculas, guiones vs. guiones bajos) al canónico. */
  resolveName(input: string): string | undefined {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(input.trim());
    return this.manifest.find((m) => norm(m.name) === target)?.name;
  }

  get(name: string): RepoInfo {
    const entry = this.manifest.find((m) => m.name === name);
    if (!entry) throw new RepoRegistryError(`El repo "${name}" no está en el manifest de producto`);
    const localPath = path.join(this.cfg.reposDir, name);
    const profile = path.join(this.cfg.knowledgePath, 'docs', 'catalog', 'repositories', `${name}.md`);
    return {
      name,
      cloneUrl: entry.cloneUrl,
      localPath,
      cloned: existsSync(path.join(localPath, '.git')),
      catalogProfile: existsSync(profile) ? profile : undefined,
    };
  }

  /** Repos ya clonados en repos_product, en el orden del manifest. */
  cloned(): RepoInfo[] {
    return this.manifest.map((m) => this.get(m.name)).filter((r) => r.cloned);
  }

  settingsFor(name: string): RepoSettings {
    const o = this.cfg.overrides.get(name) ?? {};
    const copyRaw = (o.copyFiles ?? this.cfg.copyFiles)?.replaceAll('{repo}', name);
    return {
      installCommand: o.installCommand ?? this.cfg.installCommand,
      testCommand: o.testCommand ?? this.cfg.testCommand,
      copyFiles: parseCopyFiles(copyRaw, this.cfg.baseDir),
      devCommand: o.devCommand,
      harnessDir: o.harnessDir,
    };
  }

  /**
   * Garantiza que el repo está clonado en repos_product. Si falta, lo clona con
   * `scripts/setup.sh --clone --manifest <manifest temporal con solo ese repo>`,
   * que resuelve el transporte (SSH/HTTPS) y respeta las reglas del workspace.
   */
  async ensureCloned(name: string, onProgress?: (msg: string) => void): Promise<RepoInfo> {
    const info = this.get(name);
    if (info.cloned) return info;

    const log = logger().child({ component: 'repos', repo: name });
    const plansDir = path.join(this.cfg.knowledgePath, 'plans');
    await mkdir(plansDir, { recursive: true });
    const manifestName = `.bugs-manager-${name}-${Date.now()}.manifest`;
    const tmpManifest = path.join(plansDir, manifestName);
    const line = info.cloneUrl ? `${name} ${info.cloneUrl}` : name;
    await writeFile(tmpManifest, `# generado por Bugs Manager: clonado bajo demanda\n${line}\n`);

    onProgress?.(`Clonando ${name} en repos_product/ con scripts/setup.sh…`);
    log.info('Clonando repo bajo demanda');
    try {
      const res = await run('./scripts/setup.sh', ['--clone', '--manifest', path.join('plans', manifestName)], {
        cwd: this.cfg.knowledgePath,
        timeoutMs: this.cfg.cloneTimeoutMs,
        maxOutput: 32 * 1024,
      });
      log.info({ ms: res.durationMs }, 'Clon terminado');
    } catch (err) {
      const output = err instanceof RunError ? err.result?.output : undefined;
      throw new RepoRegistryError(`No se pudo clonar ${name}: ${(err as Error).message}${output ? `\n${output.split('\n').slice(-10).join('\n')}` : ''}`);
    } finally {
      await rm(tmpManifest, { force: true });
    }

    const after = this.get(name);
    if (!after.cloned) throw new RepoRegistryError(`setup.sh terminó pero ${after.localPath} no es un clon git`);
    return after;
  }
}

function parseManifest(file: string): Array<{ name: string; cloneUrl?: string }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [name, url] = l.split(/\s+/);
      return url ? { name: name!, cloneUrl: url } : { name: name! };
    });
}

/** analytiq_widget → ANALYTIQ_WIDGET; admin-platform-config → ADMIN_PLATFORM_CONFIG */
export function envKey(repoName: string): string {
  return repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Lee REPO_<NOMBRE>_INSTALL_COMMAND / _TEST_COMMAND / _COPY_FILES del entorno y
 * los asocia a los nombres canónicos del manifest.
 */
export function parseRepoOverrides(env: NodeJS.ProcessEnv, manifestNames: string[]): Map<string, RepoOverrides> {
  const byKey = new Map(manifestNames.map((n) => [envKey(n), n] as const));
  const out = new Map<string, RepoOverrides>();
  const re = /^REPO_(.+)_(INSTALL_COMMAND|TEST_COMMAND|COPY_FILES|DEV_COMMAND|E2E_HARNESS_DIR)$/;
  for (const [k, v] of Object.entries(env)) {
    const m = re.exec(k);
    if (!m || !v?.trim()) continue;
    const name = byKey.get(m[1]!) ?? m[1]!.toLowerCase();
    const o = out.get(name) ?? {};
    if (m[2] === 'INSTALL_COMMAND') o.installCommand = v.trim();
    if (m[2] === 'TEST_COMMAND') o.testCommand = v.trim();
    if (m[2] === 'COPY_FILES') o.copyFiles = v.trim();
    if (m[2] === 'DEV_COMMAND') o.devCommand = v.trim();
    if (m[2] === 'E2E_HARNESS_DIR') o.harnessDir = v.trim();
    out.set(name, o);
  }
  return out;
}
