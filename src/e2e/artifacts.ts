import { accessSync, constants as fsConstants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { copyFile, lstat, mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { run } from '../util/exec.js';

export type Phase = 'before' | 'after';
export type PhaseStatus = 'passed' | 'failed' | 'missing';

export interface PhaseReport {
  phase: Phase;
  status: PhaseStatus;
  /** Tests que fallaron (los que interesan en la fase "before"). */
  failed: number;
  passed: number;
  /** Primer mensaje de error, recortado, para explicar en el hilo. */
  firstError: string | undefined;
}

export interface CollectedArtifact {
  phase: Phase;
  kind: 'video' | 'screenshot' | 'trace';
  /** Ruta absoluta, ya copiada fuera del worktree. */
  path: string;
  mime: string;
}

export const E2E_DIR = '.bugs-manager';

/** Directorio de trabajo de la prueba, FUERA del worktree (no contamina el repo). */
export function e2eDirFor(artifactsDir: string, jobId: string): string {
  return path.join(artifactsDir, jobId, 'e2e');
}

/** Lee el report.json que deja el wrapper. `missing` = esa fase no se ejecutó. */
export function readPhaseReport(baseDir: string, phase: Phase): PhaseReport {
  const file = path.join(baseDir, phase, 'report.json');
  const empty: PhaseReport = { phase, status: 'missing', failed: 0, passed: 0, firstError: undefined };
  if (!existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as PlaywrightReport;
    if (!raw.stats) return empty;
    const failed = (raw.stats.unexpected ?? 0) + (raw.stats.flaky ?? 0);
    const passed = raw.stats.expected ?? 0;
    return {
      phase,
      status: failed > 0 ? 'failed' : passed > 0 ? 'passed' : 'missing',
      failed,
      passed,
      firstError: firstErrorOf(raw),
    };
  } catch (err) {
    logger().warn({ component: 'e2e', file, err: (err as Error).message }, 'No se pudo leer el report de Playwright');
    return empty;
  }
}

interface PlaywrightReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number };
  errors?: Array<{ message?: string }>;
  suites?: unknown[];
}

function firstErrorOf(raw: PlaywrightReport): string | undefined {
  const top = raw.errors?.[0]?.message;
  if (top) return clean(top);
  // Los errores por test cuelgan de suites → specs → tests → results → error.
  const stack: unknown[] = [...(raw.suites ?? [])];
  while (stack.length) {
    const node = stack.pop() as Record<string, unknown> | undefined;
    if (!node || typeof node !== 'object') continue;
    for (const key of ['suites', 'specs', 'tests', 'results']) {
      const child = node[key];
      if (Array.isArray(child)) stack.push(...child);
    }
    const error = node.error as { message?: string } | undefined;
    if (error?.message) return clean(error.message);
  }
  return undefined;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function clean(msg: string): string {
  return msg.replace(ANSI, '').split('\n').slice(0, 6).join('\n').slice(0, 800);
}

/**
 * Copia vídeos, capturas y trazas de ambas fases a un directorio propio del job,
 * fuera del worktree, para que sobrevivan a la limpieza.
 */
export async function collectArtifacts(baseDir: string, destDir: string, ticketKey: string): Promise<CollectedArtifact[]> {
  const out: CollectedArtifact[] = [];
  await mkdir(destDir, { recursive: true });

  for (const phase of ['before', 'after'] as const) {
    const root = path.join(baseDir, phase, 'artifacts');
    if (!existsSync(root)) continue;
    let videoN = 0;
    let shotN = 0;
    for (const file of await walk(root)) {
      const base = path.basename(file).toLowerCase();
      let kind: CollectedArtifact['kind'] | undefined;
      let name: string | undefined;
      if (base.endsWith('.webm')) {
        videoN += 1;
        kind = 'video';
        name = `${ticketKey}-${phase}${videoN > 1 ? `-${videoN}` : ''}.webm`;
      } else if (base.endsWith('.png')) {
        shotN += 1;
        kind = 'screenshot';
        name = `${ticketKey}-${phase}-${shotN}.png`;
      } else if (base === 'trace.zip') {
        kind = 'trace';
        name = `${ticketKey}-${phase}-trace.zip`;
      }
      if (!kind || !name) continue;
      const dest = path.join(destDir, name);
      try {
        await copyFile(file, dest);
        out.push({
          phase,
          kind,
          path: dest,
          mime: kind === 'video' ? 'video/webm' : kind === 'screenshot' ? 'image/png' : 'application/zip',
        });
      } catch (err) {
        logger().warn({ component: 'e2e', file, err: (err as Error).message }, 'No se pudo copiar un artefacto');
      }
    }
  }

  // Los vídeos en mp4 se previsualizan en Slack; webm normalmente no.
  for (const art of out) {
    if (art.kind !== 'video') continue;
    const mp4 = await toMp4(art.path);
    if (mp4) {
      art.path = mp4;
      art.mime = 'video/mp4';
    }
  }
  return out;
}

let ffmpegBin: string | null | undefined;

/**
 * ffmpeg capaz de producir mp4. Ojo: el ffmpeg que Playwright instala con los
 * navegadores está compilado al mínimo (solo webm/vp8), así que se comprueba que
 * el binario tenga H.264 y contenedor mp4 antes de usarlo. Sin uno capaz se
 * mantiene el webm, que Slack reproduce igualmente.
 */
async function findFfmpeg(): Promise<string | undefined> {
  if (ffmpegBin !== undefined) return ffmpegBin ?? undefined;

  const candidates = ['ffmpeg'];
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(homedir(), '.cache', 'ms-playwright'));
  try {
    for (const dir of readdirSync(cache)) {
      if (!dir.startsWith('ffmpeg')) continue;
      for (const bin of readdirSync(path.join(cache, dir))) {
        if (bin.startsWith('ffmpeg')) candidates.push(path.join(cache, dir, bin));
      }
    }
  } catch {
    /* sin caché de Playwright */
  }

  for (const candidate of candidates) {
    try {
      const res = await run(candidate, ['-hide_banner', '-encoders'], { cwd: process.cwd(), timeoutMs: 15_000, maxOutput: 2 * 1024 * 1024 });
      if (!/libx264|h264/.test(res.output)) continue;
      ffmpegBin = candidate;
      logger().info({ component: 'e2e', ffmpeg: candidate }, 'ffmpeg con soporte mp4 localizado');
      return candidate;
    } catch {
      /* no existe o no responde */
    }
  }

  ffmpegBin = null;
  logger().info(
    { component: 'e2e' },
    'Sin ffmpeg con soporte mp4 (el de Playwright solo produce webm): los vídeos se publicarán en webm. Instálalo con "brew install ffmpeg" si los quieres en mp4.',
  );
  return undefined;
}

async function toMp4(webm: string): Promise<string | undefined> {
  const bin = await findFfmpeg();
  if (!bin) return undefined;
  const mp4 = webm.replace(/\.webm$/, '.mp4');
  try {
    await run(bin, ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], {
      cwd: path.dirname(webm),
      timeoutMs: 120_000,
    });
    return existsSync(mp4) ? mp4 : undefined;
  } catch (err) {
    logger().warn({ component: 'e2e', err: (err as Error).message }, 'No se pudo convertir el vídeo a mp4; se usará el webm');
    return undefined;
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const st = await stat(full);
      if (st.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    } catch {
      /* desaparecido entre medias */
    }
  }
  return out;
}

/**
 * Veredicto del servicio: solo hay verificación real si la MISMA prueba falló
 * antes del fix y pasó después. Lo demás se reporta tal cual, sin adornos.
 */
export function verdict(before: PhaseReport, after: PhaseReport): { verified: boolean; label: string; mismatch: boolean } {
  if (before.status === 'failed' && after.status === 'passed') {
    return { verified: true, label: 'verified (the test fails without the fix and passes with it)', mismatch: false };
  }
  if (before.status === 'missing' && after.status === 'missing') {
    return { verified: false, label: 'no automated reproduction', mismatch: false };
  }
  if (before.status === 'passed') {
    return { verified: false, label: 'the reproduction test did NOT fail before the fix, so it does not prove the bug', mismatch: true };
  }
  if (after.status !== 'passed') {
    return { verified: false, label: `the test still does not pass after the fix (${after.status})`, mismatch: true };
  }
  return { verified: false, label: `incomplete reproduction (before: ${before.status}, after: ${after.status})`, mismatch: true };
}

// ---- Manifiesto y enlaces del directorio de la prueba --------------------------

/** Lo lee el wrapper junto al spec: así no depende de flags, variables de entorno ni del cwd del agente. */
export const MANIFEST_FILE = 'bugs-manager.json';

export interface E2EManifest {
  jobId: string;
  ticketKey: string;
  appUrl: string;
  worktree: string;
  harnessFile: string;
  harnessUrl: string;
  /** Directorio de salida servido tal cual (absoluto): permite saber cuándo terminó la reconstrucción. */
  servedRoot: string | undefined;
  createdAt: string;
}

export async function writeManifest(e2eDir: string, manifest: E2EManifest): Promise<string> {
  const file = path.join(e2eDir, MANIFEST_FILE);
  await writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
  return file;
}

/**
 * Enlaza node_modules del servicio en el directorio de la prueba desde el principio, para que
 * `import '@playwright/test'` o `import 'playwright'` resuelvan también en los scripts de
 * exploración del agente, no solo cuando corre el wrapper (que lo creaba tarde: el agente
 * intentaba `ln` por su cuenta y se le denegaba).
 */
export async function linkNodeModules(e2eDir: string, serviceRoot: string): Promise<void> {
  const link = path.join(e2eDir, 'node_modules');
  try {
    await lstat(link);
    return; // ya existe
  } catch {
    /* no existe todavía */
  }
  await symlink(path.join(serviceRoot, 'node_modules'), link, 'dir');
}
