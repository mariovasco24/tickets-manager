#!/usr/bin/env node
/**
 * Ejecuta un spec de Playwright contra el servidor de desarrollo de un worktree,
 * grabando vídeo, capturas y traza. Lo invoca Claude Code en primer plano:
 *
 *   node <BUGS_MANAGER>/bin/e2e-run.mjs --phase before "<e2eDir>/AN-1234.spec.ts"
 *   node <BUGS_MANAGER>/bin/e2e-run.mjs --phase after  "<e2eDir>/AN-1234.spec.ts"
 *
 * Junto al spec, el servicio deja bugs-manager.json (URL de la app, worktree y directorio
 * servido): el wrapper lo lee solo, sin flags ni variables. Antes de lanzar la prueba
 * espera a que la app responda y a que la reconstrucción en watch haya recogido la última
 * edición del worktree, para que el agente nunca tenga que esperar por su cuenta (un bucle
 * "until" mirando un archivo que no existía costó 10 minutos en un job real).
 *
 * Sale con el código de Playwright (0 = pasó) y SIEMPRE deja report.json en <e2eDir>/<phase>/.
 * El servicio lee ese informe: no se fía del texto del agente.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST_FILE = 'bugs-manager.json';
const FLAGS_WITH_VALUE = new Set(['--phase', '--url', '--worktree', '--wait-ms', '--rebuild-wait-ms']);
// Directorios que nunca cuentan como "fuente" al buscar la última edición del worktree.
const SKIP_DIRS = new Set(['node_modules', 'www', 'dist', 'build', 'out', 'coverage', 'tmp']);

const { flags, positional } = parseArgs(process.argv.slice(2));
const phase = flags['--phase'] ?? 'before';
const specArg = positional[0];
if (!['before', 'after'].includes(phase)) fail('--phase debe ser "before" o "after"');
if (!specArg) fail('falta la ruta del spec');

const specPath = path.resolve(process.cwd(), specArg);
if (!existsSync(specPath)) fail(`el spec no existe: ${specPath}`);
const baseDir = path.dirname(specPath);

// Manifiesto del servicio, junto al spec. Los flags y las variables de entorno tienen prioridad.
const manifest = readManifest(baseDir);
const appUrl = String(flags['--url'] ?? process.env.BUGS_MANAGER_APP_URL ?? manifest.appUrl ?? '').replace(/\/+$/, '');
const worktree = flags['--worktree'] ?? process.env.BUGS_MANAGER_WORKTREE ?? manifest.worktree;
const servedRoot = manifest.servedRoot;
const waitMs = Number(flags['--wait-ms'] ?? process.env.BUGS_MANAGER_WAIT_MS ?? 120_000);
const rebuildWaitMs = Number(flags['--rebuild-wait-ms'] ?? process.env.BUGS_MANAGER_REBUILD_WAIT_MS ?? 150_000);
if (!appUrl) fail(`falta la URL de la app: ni --url, ni BUGS_MANAGER_APP_URL, ni ${MANIFEST_FILE} junto al spec`);

// El spec vive fuera del repo, donde no hay @playwright/test: un enlace a nuestro node_modules
// deja que la importación se resuelva sin instalar nada. El servicio ya lo crea; esto es red.
const link = path.join(baseDir, 'node_modules');
try {
  if (!existsSync(link)) symlinkSync(path.join(ROOT, 'node_modules'), link, 'dir');
} catch (err) {
  fail(`no pude enlazar node_modules en ${baseDir}: ${err.message}`);
}

const outDir = path.join(baseDir, phase);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const waits = { phase, appUrl, httpMs: 0, rebuild: undefined };

// 1) La app responde (build inicial o reinicio del servidor).
const t0 = Date.now();
const ready = await waitForHttp(appUrl, waitMs);
waits.httpMs = Date.now() - t0;
if (!ready) {
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ status: 'unreachable', appUrl }, null, 2));
  fail(`la app no respondió en ${appUrl} tras ${Math.round(waitMs / 1000)}s`);
}

// 2) La reconstrucción en watch ya recogió la última edición del worktree. Sin esto la fase
//    "after" podía medir el bundle viejo (el bug seguía) o el agente se ponía a esperar a mano.
waits.rebuild = await waitForRebuild();
await sleep(1500); // margen para que se asiente lo recién escrito
writeFileSync(path.join(outDir, 'wrapper.json'), JSON.stringify(waits, null, 2));

const configPath = path.join(outDir, 'playwright.config.mjs');
writeFileSync(
  configPath,
  `export default {
  testDir: ${JSON.stringify(baseDir)},
  outputDir: ${JSON.stringify(path.join(outDir, 'artifacts'))},
  timeout: 120000,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: ${JSON.stringify(path.join(outDir, 'report.json'))} }]],
  use: {
    baseURL: ${JSON.stringify(appUrl)},
    headless: true,
    viewport: { width: 1280, height: 720 },
    // El vídeo es evidencia para una persona: tamaño legible y acciones a ritmo visible.
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    screenshot: 'on',
    trace: 'on',
    actionTimeout: 20000,
    navigationTimeout: 60000,
    launchOptions: { slowMo: ${Number(process.env.BUGS_MANAGER_SLOWMO ?? 150)} },
  },
};
`,
);

const bin = path.join(ROOT, 'node_modules', '.bin', 'playwright');
if (!existsSync(bin)) fail('Playwright no está instalado en el servicio (pnpm add -D @playwright/test)');

const res = spawnSync(bin, ['test', specPath, '--config', configPath], {
  cwd: baseDir,
  stdio: 'inherit',
  env: { ...process.env, BUGS_MANAGER_PHASE: phase, FORCE_COLOR: '0' },
});

if (res.error) fail(`no se pudo ejecutar Playwright: ${res.error.message}`);
if (!existsSync(path.join(outDir, 'report.json'))) {
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ status: 'no-report', exitCode: res.status }, null, 2));
}
say(`fase "${phase}" terminó con código ${res.status}. Artefactos en ${outDir}`);
process.exit(res.status ?? 1);

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) flags[a] = argv[++i];
    else if (a.startsWith('--')) flags[a] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function readManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${MANIFEST_FILE} ilegible: ${err.message}`);
  }
}

function fail(msg) {
  console.error(`[e2e-run] ${msg}`);
  process.exit(2);
}
function say(msg) {
  console.log(`[e2e-run] ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
      clearTimeout(t);
      if (res.status < 500) return true;
    } catch {
      if (!notified) {
        say(`esperando a que ${url} responda (la build puede tardar varios minutos)…`);
        notified = true;
      }
    }
    await sleep(3000);
  }
  return false;
}

/**
 * Espera a que el directorio servido sea más nuevo que la última edición del worktree y lleve
 * 2 s sin cambios (la build terminó de escribir). Solo aplica cuando el servidor sirve un
 * directorio de salida en disco (Stencil: www/); con servidores en memoria no hay nada que esperar.
 * Si la última edición no dispara ninguna build (p. ej. un .md), se sigue tras el tope, avisando.
 */
async function waitForRebuild() {
  if (!worktree || !servedRoot) return { skipped: true, reason: 'sin directorio de salida conocido' };
  if (!existsSync(servedRoot)) return { skipped: true, reason: `${servedRoot} no existe` };
  const started = Date.now();
  const deadline = started + rebuildWaitMs;
  let notified = false;
  for (;;) {
    const src = newest(worktree, { skipDirs: SKIP_DIRS, skipPath: servedRoot, skipFile: isNotSource });
    const out = newest(servedRoot, { skipDirs: new Set(['node_modules']), skipFile: isHarness });
    const quietMs = Date.now() - out.mtime;
    const info = { waitedMs: Date.now() - started, timedOut: false, lastEdit: rel(src.file), newestOutput: rel(out.file) };
    if (out.mtime >= src.mtime && quietMs >= 2000) {
      if (notified) say(`reconstrucción recogida en ${Math.round(info.waitedMs / 1000)}s (${info.newestOutput} ya es más nuevo que ${info.lastEdit})`);
      return info;
    }
    if (Date.now() >= deadline) {
      say(`AVISO: tras ${Math.round(rebuildWaitMs / 1000)}s la salida (${info.newestOutput}) sigue siendo más vieja que la última edición (${info.lastEdit}); sigo igualmente`);
      return { ...info, timedOut: true };
    }
    if (!notified) {
      say(`esperando a que el servidor reconstruya (última edición: ${info.lastEdit})…`);
      notified = true;
    }
    await sleep(1500);
  }
}

/** Archivo más reciente bajo un directorio (sin seguir enlaces ni entrar en directorios ocultos). */
function newest(dir, { skipDirs, skipPath, skipFile }) {
  let best = { mtime: 0, file: dir };
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (skipPath && full === skipPath) continue;
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name) && !e.name.startsWith('.')) stack.push(full);
        continue;
      }
      if (!e.isFile() || skipFile(e.name)) continue;
      try {
        const st = statSync(full);
        if (st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, file: full };
      } catch {
        /* desaparecido entre medias */
      }
    }
  }
  return best;
}

// Ediciones que no disparan una build: no hay que esperarlas.
function isNotSource(name) {
  return (
    isHarness(name) ||
    /\.(md|txt|log)$/i.test(name) ||
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(name) ||
    name.startsWith('.env') ||
    name === '.DS_Store'
  );
}
function isHarness(name) {
  return name.startsWith('_bugs-manager');
}
function rel(file) {
  return worktree ? path.relative(worktree, file) || '.' : file;
}
