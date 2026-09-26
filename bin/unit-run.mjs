#!/usr/bin/env node
/**
 * Ejecuta el spec de regresión del REPOSITORIO y registra el resultado para que el servicio
 * lo verifique: rojo antes del fix, verde después, igual que hace e2e-run.mjs con Playwright.
 *
 *   node <BUGS_MANAGER>/bin/unit-run.mjs --phase before --cwd "<worktree>" --out "<dir>" --spec "<ruta relativa>" -- <comando de test>
 *   node <BUGS_MANAGER>/bin/unit-run.mjs --phase after  --cwd "<worktree>" --out "<dir>" --spec "<ruta relativa>" -- <comando de test>
 *
 * Todo lo que va después de "--" es el comando, tal cual (p. ej. npx stencil test --spec -- src/x.spec.ts).
 * Deja <dir>/regression/<phase>.json con comando, spec, código de salida y cola de la salida, y sale con el
 * código del comando. El servicio exige el MISMO comando y spec en ambas fases y que el spec esté entre
 * los archivos del fix: afirmar que se probó no basta.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flagsList = sep === -1 ? argv : argv.slice(0, sep);
const command = sep === -1 ? [] : argv.slice(sep + 1);
const flags = {};
for (let i = 0; i < flagsList.length; i++) {
  const a = flagsList[i];
  if (a.startsWith('--')) flags[a] = flagsList[i + 1] && !flagsList[i + 1].startsWith('--') ? flagsList[++i] : true;
}

const phase = flags['--phase'];
const cwd = path.resolve(flags['--cwd'] ?? process.cwd());
const out = flags['--out'] ? path.resolve(flags['--out']) : undefined;
const spec = flags['--spec'];

function fail(msg) {
  console.error(`[unit-run] ${msg}`);
  process.exit(2);
}
if (!['before', 'after'].includes(phase)) fail('--phase debe ser "before" o "after"');
if (!out) fail('falta --out "<directorio de registros>"');
if (!spec) fail('falta --spec "<ruta relativa del spec dentro del worktree>"');
if (!command.length) fail('falta el comando de test después de "--"');
if (!existsSync(cwd)) fail(`--cwd no existe: ${cwd}`);

const specExists = existsSync(path.join(cwd, spec));
if (!specExists) console.error(`[unit-run] AVISO: el spec ${spec} no existe en ${cwd}`);

const regressionDir = path.join(out, 'regression');
mkdirSync(regressionDir, { recursive: true });

const startedAt = Date.now();
console.log(`[unit-run] fase "${phase}" · ${spec} · ${command.join(' ')}`);
const child = spawn(command[0], command.slice(1), {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CI: process.env.CI ?? 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
});

let tail = '';
const keep = (d) => {
  const s = d.toString();
  tail = (tail + s).slice(-12_000);
};
child.stdout.on('data', (d) => {
  process.stdout.write(d);
  keep(d);
});
child.stderr.on('data', (d) => {
  process.stderr.write(d);
  keep(d);
});

child.on('error', (err) => {
  write(127, `no se pudo ejecutar ${command[0]}: ${err.message}`);
  process.exit(127);
});
child.on('close', (code, signal) => {
  const exitCode = code ?? (signal ? 128 : 1);
  write(exitCode);
  console.log(`[unit-run] fase "${phase}" terminó con código ${exitCode} (${exitCode === 0 ? 'PASA' : 'FALLA'})`);
  process.exit(exitCode);
});

function write(exitCode, error) {
  const report = {
    phase,
    spec,
    specExists,
    cwd,
    command: command.join(' '),
    exitCode,
    passed: exitCode === 0,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    outputTail: tail.split('\n').slice(-40).join('\n'),
    ...(error ? { error } : {}),
  };
  writeFileSync(path.join(regressionDir, `${phase}.json`), JSON.stringify(report, null, 2));
}
