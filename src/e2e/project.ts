import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type ProjectKind = 'frontend' | 'backend' | 'unknown';

export interface ProjectInfo {
  kind: ProjectKind;
  /** Framework detectado (stencil, react, vite…), solo informativo. */
  framework: string | undefined;
  /** Script de arranque elegido, ya como comando ejecutable (p. ej. "npm run start"). */
  devCommand: string | undefined;
  /** Otros scripts que podrían servir, para el mensaje cuando no está claro. */
  devCandidates: string[];
  /** Dónde dejar el harness para que el dev server lo sirva (relativo al worktree). */
  harnessDir: string | undefined;
  /** Frameworks de test presentes en el repo (para el futuro punto de regresión). */
  testFrameworks: string[];
}

/** Dependencias que delatan una app con interfaz servida por un dev server. */
const FRONTEND_DEPS: Array<[string, string]> = [
  ['@stencil/core', 'stencil'],
  ['next', 'next'],
  ['@angular/core', 'angular'],
  ['vue', 'vue'],
  ['react-scripts', 'react-scripts'],
  ['vite', 'vite'],
  ['webpack-dev-server', 'webpack'],
  ['react', 'react'],
  ['svelte', 'svelte'],
];

const BACKEND_DEPS = ['express', 'serverless', 'fastify', 'koa', 'aws-sdk', '@nestjs/core'];

const TEST_DEPS = ['@playwright/test', 'cypress', 'jest', 'vitest', 'mocha', '@stencil/core'];

/** Orden de preferencia para arrancar la app en desarrollo. */
const DEV_SCRIPTS = ['start', 'dev', 'serve', 'start:dev', 'dev:server', 'www'];

/**
 * Determina, leyendo package.json, si el worktree es una app con interfaz que se
 * puede levantar para reproducir un bug en el navegador, y cómo arrancarla.
 * No ejecuta nada: solo inspecciona archivos.
 */
export function detectProject(worktreePath: string): ProjectInfo {
  const pkgPath = path.join(worktreePath, 'package.json');
  const empty: ProjectInfo = {
    kind: 'unknown',
    framework: undefined,
    devCommand: undefined,
    devCandidates: [],
    harnessDir: undefined,
    testFrameworks: [],
  };
  if (!existsSync(pkgPath)) return empty;

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as typeof pkg;
  } catch {
    return empty;
  }

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};
  const hit = FRONTEND_DEPS.find(([dep]) => dep in deps);
  const isBackend = BACKEND_DEPS.some((d) => d in deps);
  const kind: ProjectKind = hit ? 'frontend' : isBackend ? 'backend' : 'unknown';

  const devCandidates = DEV_SCRIPTS.filter((s) => typeof scripts[s] === 'string');
  const chosen = devCandidates[0];

  return {
    kind,
    framework: hit?.[1],
    devCommand: chosen ? `npm run ${chosen}` : undefined,
    devCandidates,
    harnessDir: kind === 'frontend' ? detectHarnessDir(worktreePath) : undefined,
    testFrameworks: TEST_DEPS.filter((d) => d in deps),
  };
}

/** Carpeta servida por el dev server donde dejar la página de embebido. */
function detectHarnessDir(worktreePath: string): string | undefined {
  for (const candidate of ['src/html_pages', 'src/pages', 'public', 'src', 'static']) {
    if (existsSync(path.join(worktreePath, candidate))) return candidate;
  }
  return undefined;
}

/**
 * Bundles que el dev server publica, para que el harness cargue los lanzadores
 * LOCALES y no los publicados. Se busca tras la build, así que puede estar vacío
 * al principio (el harness se regenera cuando aparecen).
 */
export function findLocalBundles(worktreePath: string): { esm: string | undefined; nomodule: string | undefined } {
  for (const root of ['www/build', 'dist/build', 'build', 'dist']) {
    const dir = path.join(worktreePath, root);
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const esm = files.find((f) => f.endsWith('.esm.js'));
    if (!esm) continue;
    const base = esm.replace(/\.esm\.js$/, '');
    const nomodule = files.find((f) => f === `${base}.js`);
    const served = root.replace(/^(www|dist)\//, '');
    return { esm: `/${served}/${esm}`, nomodule: nomodule ? `/${served}/${nomodule}` : undefined };
  }
  return { esm: undefined, nomodule: undefined };
}

/**
 * Directorio de salida que el dev server sirve tal cual (Stencil: www/, Angular: dist/).
 * Lo que se escribe ahí se sirve al instante, sin esperar a ninguna build, y una
 * reconstrucción en watch no lo borra. Los servidores que sirven desde memoria
 * (Vite, Next) no tienen uno: se devuelve undefined.
 */
export function detectServedRoot(worktreePath: string): string | undefined {
  for (const root of ['www', 'dist']) {
    const dir = path.join(worktreePath, root);
    if (!existsSync(dir)) continue;
    if (existsSync(path.join(dir, 'index.html')) || existsSync(path.join(dir, 'build'))) return root;
  }
  return undefined;
}
