import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import type { RegressionInfo } from '../shared/job-types.js';

/**
 * Spec de regresión obligatorio: el servicio lee los registros que deja bin/unit-run.mjs
 * (rojo antes del fix, verde después) y exige que el spec esté entre los archivos del fix.
 * La prueba de Playwright del harness es evidencia para QA, no cuenta: vive fuera del repo.
 */
export type RegressionPhase = 'before' | 'after';

export interface RegressionRun {
  phase: RegressionPhase;
  status: 'passed' | 'failed' | 'missing';
  spec: string | undefined;
  command: string | undefined;
  exitCode: number | undefined;
  outputTail: string | undefined;
}

export interface ClaimedRegression {
  kind: 'unit' | 'e2e' | 'none';
  files: string[];
  reason?: string;
}

const TEST_FILE_RE = /(\.spec\.|\.test\.|(^|\/)__tests__\/|(^|\/)cypress\/e2e\/|(^|\/)e2e\/)/i;

export function isTestFile(file: string): boolean {
  return TEST_FILE_RE.test(file);
}

export function readRegressionRun(baseDir: string, phase: RegressionPhase): RegressionRun {
  const file = path.join(baseDir, 'regression', `${phase}.json`);
  const missing: RegressionRun = { phase, status: 'missing', spec: undefined, command: undefined, exitCode: undefined, outputTail: undefined };
  if (!existsSync(file)) return missing;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { spec?: string; command?: string; exitCode?: number; outputTail?: string };
    if (typeof raw.exitCode !== 'number') return missing;
    return {
      phase,
      status: raw.exitCode === 0 ? 'passed' : 'failed',
      spec: raw.spec,
      command: raw.command,
      exitCode: raw.exitCode,
      outputTail: raw.outputTail,
    };
  } catch (err) {
    logger().warn({ component: 'regression', file, err: (err as Error).message }, 'No se pudo leer el registro del spec de regresión');
    return missing;
  }
}

/** Ruta reportada por Claude o por el wrapper ("src/x.spec.ts") contra las del fix ("<repo>/src/x.spec.ts"). */
function inChanges(spec: string | undefined, changedFiles: string[]): boolean {
  if (!spec) return false;
  const clean = spec.replace(/^\.\//, '');
  return changedFiles.some((f) => f === clean || f.endsWith(`/${clean}`));
}

/**
 * Veredicto del servicio. `verified` solo si el MISMO spec, con el MISMO comando, falló antes
 * y pasó después, y el spec está entre los archivos del fix. Lo demás se explica tal cual.
 */
export function evaluateRegression(baseDir: string, claimed: ClaimedRegression | undefined, changedFiles: string[]): RegressionInfo {
  const before = readRegressionRun(baseDir, 'before');
  const after = readRegressionRun(baseDir, 'after');
  const testFiles = changedFiles.filter(isTestFile);
  const kind: RegressionInfo['kind'] = claimed?.kind === 'e2e' ? 'e2e' : claimed?.kind === 'none' && !testFiles.length ? 'none' : 'unit';
  const files = [...new Set([...(claimed?.files ?? []), ...testFiles])];
  const spec = after.spec ?? before.spec ?? claimed?.files[0] ?? testFiles[0];
  const base = { kind, files, reason: claimed?.reason, command: after.command ?? before.command };

  if (!testFiles.length && before.status === 'missing' && after.status === 'missing') {
    return { ...base, kind: 'none', verdict: 'none', label: `none — ${claimed?.reason?.trim() || 'no spec among the changed files and no red/green run recorded'}` };
  }
  if (before.status === 'missing' || after.status === 'missing') {
    const which = [before.status === 'missing' ? 'before' : undefined, after.status === 'missing' ? 'after' : undefined].filter(Boolean).join(' and ');
    return {
      ...base,
      verdict: 'unverified',
      label: `unverified — ${testFiles.length ? `spec ${testFiles.join(', ')} is in the fix but` : 'a run was recorded but'} the ${which} phase was not run through the wrapper`,
    };
  }
  if (before.command !== after.command || before.spec !== after.spec) {
    return { ...base, verdict: 'mismatch', label: 'mismatch — the before and after phases ran different specs or commands' };
  }
  if (!inChanges(spec, changedFiles)) {
    return { ...base, verdict: 'mismatch', label: `mismatch — the spec that ran (${spec}) is not among the changed files of the fix` };
  }
  if (before.status === 'passed') {
    return { ...base, verdict: 'mismatch', label: `mismatch — ${spec} passes WITHOUT the fix, so it does not cover the bug` };
  }
  if (after.status === 'failed') {
    return { ...base, verdict: 'mismatch', label: `mismatch — ${spec} still fails after the fix` };
  }
  return { ...base, verdict: 'verified', label: `verified (${kind}) — ${spec} fails without the fix and passes with it` };
}
