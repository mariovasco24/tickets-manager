import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { findLocalBundles } from './project.js';

/** Credenciales y destino de datos contra el que se monta el widget en la prueba. */
export interface DataEnvironment {
  name: string;
  domain: string;
  apiKey: string;
  appId: string;
  userId: string;
  qrveyId: string;
}

export interface HarnessResult {
  /** Ruta absoluta del archivo escrito. */
  file: string;
  /** URL con la que abrirlo en el navegador. */
  url: string;
  /** Si los lanzadores locales ya se pudieron resolver (build terminada). */
  bundlesResolved: boolean;
  /** true si está en el directorio que el dev server sirve tal cual: se edita y se recarga, sin build. */
  servedDirectly: boolean;
}

export const HARNESS_PREFIX = '_bugs-manager';

/** Claves de cada ambiente, con los mismos nombres que el objeto de configuración del embebido. */
const ENV_KEYS = ['domain', 'api_key', 'app_id', 'user_id', 'qrveyid'] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const VAR_SUFFIXES = ['DOMAIN', 'API_KEY', 'APP_ID', 'USER_ID', 'QRVEYID'] as const;

/**
 * Ambientes de datos. Fuente principal: un archivo JSON con TODOS los ambientes
 * (E2E_ENVIRONMENTS_FILE, por defecto ./environments.json, fuera del control de
 * versiones porque lleva api_keys); el .env solo dice cuál usar (E2E_ENV). Así, si un
 * ambiente falla, cambiar a otro es editar un nombre y reiniciar:
 *
 *   { "demo": { "domain": "https://demo.qrvey.com", "api_key": "…", "app_id": "…", "user_id": "…", "qrveyid": "…" } }
 *
 * Se admite también el esquema antiguo por variables (E2E_ENVS=demo,qa más
 * E2E_ENV_DEMO_DOMAIN/_API_KEY/_APP_ID/_USER_ID/_QRVEYID, con el NOMBRE en mayúsculas).
 * Si un nombre está en ambos, gana el archivo. Las claves nunca salen de aquí hacia
 * Slack, el dashboard ni los logs.
 */
export function loadEnvironments(env: NodeJS.ProcessEnv = process.env, file?: string): Map<string, DataEnvironment> {
  const out = new Map<string, DataEnvironment>();
  for (const [name, e] of fromEnvVars(env)) out.set(name, e);
  for (const [name, e] of readEnvironmentsFile(file).environments) out.set(name, e);
  return out;
}

function fromEnvVars(env: NodeJS.ProcessEnv): Map<string, DataEnvironment> {
  const out = new Map<string, DataEnvironment>();
  for (const name of listedNames(env)) {
    const k = (suffix: string) => env[`${envPrefix(name)}${suffix}`]?.trim() ?? '';
    const domain = k('DOMAIN');
    if (!domain) continue; // sin dominio no hay ambiente utilizable
    out.set(name, { name, domain: domain.replace(/\/+$/, ''), apiKey: k('API_KEY'), appId: k('APP_ID'), userId: k('USER_ID'), qrveyId: k('QRVEYID') });
  }
  return out;
}

function listedNames(env: NodeJS.ProcessEnv): string[] {
  return (env.E2E_ENVS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envPrefix(name: string): string {
  return `E2E_ENV_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
}

interface FileRead {
  exists: boolean;
  error: string | undefined;
  environments: Map<string, DataEnvironment>;
  /** Entradas descartadas o incompletas, para el diagnóstico (nombres y claves, nunca valores). */
  notes: string[];
}

function readEnvironmentsFile(file: string | undefined): FileRead {
  const out: FileRead = { exists: false, error: undefined, environments: new Map(), notes: [] };
  if (!file || !existsSync(file)) return out;
  out.exists = true;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    out.error = `JSON inválido: ${(err as Error).message}`;
    return out;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    out.error = 'debe ser un objeto { "<nombre>": { domain, api_key, app_id, user_id, qrveyid } }';
    return out;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      out.notes.push(`${name}: no es un objeto`);
      continue;
    }
    const v = value as Record<string, unknown>;
    const str = (key: EnvKey) => (typeof v[key] === 'string' ? (v[key] as string).trim() : '');
    if (!str('domain')) {
      out.notes.push(`${name}: falta domain (sin él no cuenta)`);
      continue;
    }
    const missing = ENV_KEYS.filter((key) => !str(key));
    if (missing.length) out.notes.push(`${name}: faltan ${missing.join(', ')}`);
    out.environments.set(name, {
      name,
      domain: str('domain').replace(/\/+$/, ''),
      apiKey: str('api_key'),
      appId: str('app_id'),
      userId: str('user_id'),
      qrveyId: str('qrveyid'),
    });
  }
  return out;
}

export function pickEnvironment(envs: Map<string, DataEnvironment>, preferred: string | undefined): DataEnvironment | undefined {
  if (preferred && envs.has(preferred)) return envs.get(preferred);
  return envs.size === 1 ? [...envs.values()][0] : undefined;
}

/** Claves obligatorias que faltan en un ambiente (para decirlo sin revelar valores). */
export function missingKeys(env: DataEnvironment): string[] {
  const missing: string[] = [];
  if (!env.apiKey) missing.push('API_KEY');
  if (!env.appId) missing.push('APP_ID');
  if (!env.userId) missing.push('USER_ID');
  return missing;
}

/**
 * Comprobación ligera de que el ambiente responde. Cualquier respuesta HTTP vale
 * (incluso 401/403): lo que se descarta es que el host no exista o no conteste.
 */
export async function checkEnvironment(env: DataEnvironment, timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(env.domain, { method: 'GET', signal: controller.signal, redirect: 'manual' });
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Escribe la página de embebido con los lanzadores apuntando al dev server LOCAL.
 * Es lo que garantiza que la prueba mide el código del worktree y no el bundle
 * publicado en el dominio.
 *
 * Dónde se escribe: si el servidor sirve un directorio de salida tal cual (www/ en
 * Stencil), el archivo va DIRECTAMENTE ahí. Dejarlo en src/ obligaba a esperar a que
 * una build lo copiase, y en los jobs reales esa copia no llegaba: el agente perdía
 * minutos descubriéndolo y copiándolo a mano. Sin directorio de salida (Vite y
 * similares sirven las fuentes), va al directorio fuente detectado.
 */
export async function writeHarness(opts: {
  worktreePath: string;
  harnessDir: string;
  /** Directorio de salida servido tal cual, relativo al worktree (p. ej. "www"), si existe. */
  servedRoot: string | undefined;
  appUrl: string;
  env: DataEnvironment;
  ticketKey: string;
}): Promise<HarnessResult> {
  const bundles = findLocalBundles(opts.worktreePath);
  const esm = bundles.esm ? `${opts.appUrl}${bundles.esm}` : undefined;
  const nomodule = bundles.nomodule ? `${opts.appUrl}${bundles.nomodule}` : undefined;

  const config = {
    api_key: opts.env.apiKey,
    app_id: opts.env.appId,
    domain: opts.env.domain,
    user_id: opts.env.userId,
    qrveyid: opts.env.qrveyId,
    settings: { view: 'CUSTOM_VIEW' },
  };

  const launchers = esm
    ? `<script type="module" src="${esm}"></script>\n  ${nomodule ? `<script nomodule src="${nomodule}"></script>` : ''}`
    : `<!-- TODO(Claude): la build aún no había terminado al generar este archivo.
       Lista el directorio de salida (p. ej. ls "${opts.worktreePath}/www/build/"*.esm.js) y pon aquí el lanzador,
       SIEMPRE con el prefijo ${opts.appUrl} (servidor local), nunca ${opts.env.domain}. -->
  <script type="module" src="${opts.appUrl}/build/REEMPLAZA.esm.js"></script>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Bugs Manager harness — ${opts.ticketKey}</title>
  <style>html,body{margin:0;height:100%}#host{height:100vh}</style>
</head>
<body>
  <div id="host">
    <!-- TODO(Claude): cambia el tag y los settings al widget que reproduce el bug -->
    <an-dashboard config="anSuiteConfig"></an-dashboard>
  </div>

  <script>
    var anSuiteConfig = ${JSON.stringify(config, null, 2).replace(/\n/g, '\n    ')};
  </script>

  <!-- Lanzadores LOCALES: el código bajo prueba es el de este worktree -->
  ${launchers}
</body>
</html>
`;

  const file = harnessFileFor(opts);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, html, 'utf8');
  const url = harnessUrlFor(opts);
  logger().info(
    { component: 'harness', file, url, bundlesResolved: Boolean(esm), servedDirectly: Boolean(opts.servedRoot) },
    'Harness de embebido generado',
  );
  return { file, url, bundlesResolved: Boolean(esm), servedDirectly: Boolean(opts.servedRoot) };
}

/** Ruta pública del harness: el dev server sirve el directorio detectado sin el prefijo src/. */
function servedPathOf(harnessDir: string): string {
  return harnessDir.replace(/^(src|public|static)\/?/, '');
}

export function harnessFileFor(opts: { worktreePath: string; harnessDir: string; servedRoot: string | undefined }): string {
  const dir = opts.servedRoot ? path.join(opts.worktreePath, opts.servedRoot, servedPathOf(opts.harnessDir)) : path.join(opts.worktreePath, opts.harnessDir);
  return path.join(dir, `${HARNESS_PREFIX}-harness.html`);
}

export function harnessUrlFor(opts: { appUrl: string; harnessDir: string }): string {
  const servedPath = servedPathOf(opts.harnessDir);
  return `${opts.appUrl}/${servedPath ? `${servedPath}/` : ''}${HARNESS_PREFIX}-harness.html`;
}

/**
 * Comprueba por HTTP que el dev server sirve el harness antes de entregárselo al
 * agente. Si no responde 200, mejor saberlo aquí y decírselo que dejar que lo
 * descubra a golpe de curl y sleep.
 */
export async function verifyHarness(url: string, timeoutMs = 20_000): Promise<{ ok: boolean; status: number | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let status: number | undefined;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
      status = res.status;
      if (res.status === 200) return { ok: true, status };
    } catch {
      status = undefined;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, status };
}

/**
 * Explica, SIN valores, qué se encontró y qué falta: el archivo de ambientes y las variables.
 * Va al hilo de Slack y al log de arranque: "no hay ningún ambiente" a secas obligaba a
 * adivinar si faltaba el archivo, un domain, o si el nombre de las variables no coincidía.
 */
export function explainEnvironments(env: NodeJS.ProcessEnv = process.env, file?: string): string {
  const parts: string[] = [];
  const f = readEnvironmentsFile(file);
  if (!file) parts.push('sin archivo de ambientes configurado (E2E_ENVIRONMENTS_FILE)');
  else if (!f.exists) parts.push(`${file} no existe (copia environments.example.json y rellénalo)`);
  else if (f.error) parts.push(`${file}: ${f.error}`);
  else {
    const names = [...f.environments.keys()];
    parts.push(`${file}: ${names.length ? `ambientes ${names.join(', ')}` : 'sin ambientes utilizables'}${f.notes.length ? ` · ${f.notes.join('; ')}` : ''}`);
  }

  // Esquema por variables: solo se menciona si hay algo, y se detecta el error clásico de que el
  // nombre de E2E_ENVS no coincida con el de las claves (E2E_ENVS=qa con E2E_ENV_DEMO_*).
  const listed = listedNames(env);
  const present = new Set<string>();
  for (const key of Object.keys(env)) {
    const m = /^E2E_ENV_(.+)_(DOMAIN|API_KEY|APP_ID|USER_ID|QRVEYID)$/.exec(key);
    if (m) present.add(m[1]!);
  }
  if (listed.length || present.size) {
    const bits = listed.map((name) => {
      const prefix = envPrefix(name);
      const missing = VAR_SUFFIXES.filter((k) => !env[`${prefix}${k}`]?.trim());
      if (!missing.length) return `${name}: completo`;
      return `${name}: faltan ${missing.map((m) => prefix + m).join(', ')}${missing.includes('DOMAIN') ? ' (sin DOMAIN no cuenta)' : ''}`;
    });
    const listedTokens = new Set(listed.map((n) => envPrefix(n).slice('E2E_ENV_'.length, -1)));
    const orphan = [...present].filter((p) => !listedTokens.has(p));
    if (orphan.length) bits.push(`las claves ${orphan.map((o) => `E2E_ENV_${o}_*`).join(', ')} no corresponden a ningún nombre de E2E_ENVS (deben coincidir)`);
    parts.push(`variables: E2E_ENVS=${listed.join(',') || '(vacío)'} → ${bits.join('; ')}`);
  }
  return parts.join(' · ');
}
