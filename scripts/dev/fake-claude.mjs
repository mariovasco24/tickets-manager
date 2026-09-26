#!/usr/bin/env node
/**
 * Claude Code falso para el banco de pruebas: habla el mismo `stream-json` y
 * respeta el contrato, pero es determinista y gratis. Ejecuta de verdad el
 * wrapper de Playwright, así que el ciclo rojo → verde se prueba en serio.
 *
 * RIG_MODE:
 *   happy     reproduce, escribe el spec de regresión (rojo), arregla, spec en verde, verifica (camino completo)
 *   mismatch  reproduce pero NO arregla, dice "reproduced" y NO trae spec (fuerza la decisión humana)
 *   codeonly  arregla sin reproducir (cuando no hay entorno), con spec de regresión
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const sid =
  argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : 'sess-rig';
const system = argv.includes('--append-system-prompt') ? argv[argv.indexOf('--append-system-prompt') + 1] : '';
const prompt = readFileSync(0, 'utf8');
const mode = process.env.RIG_MODE ?? 'happy';
const cwd = process.cwd();

const emit = (o) => process.stdout.write(`${JSON.stringify({ session_id: sid, ...o })}\n`);
const say = (text) => emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (name, input) => emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } });
const result = (text) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });
const finish = (text) => {
  emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 500, num_turns: 3, total_cost_usd: 0.01, result: text });
  process.exit(0);
};
const json = (obj) => `Listo.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

emit({ type: 'system', subtype: 'init', model: 'rig-model', cwd, tools: ['Read', 'Edit', 'Bash'], permissionMode: 'acceptEdits' });

// --- Triaje -----------------------------------------------------------------
if (prompt.includes('Determina en qué repositorio')) {
  say('Busco en el catálogo.');
  tool('Read', { file_path: 'docs/catalog/retrieval-index.md' });
  result('# retrieval index (rig)');
  finish(
    json({
      status: 'repos',
      repos: [{ name: process.env.RIG_REPO ?? 'widget_front', reason: 'el componente vive aquí', confidence: 'high' }],
      analysis: 'La etiqueta por defecto se calcula en el cliente.',
    }),
  );
}

// --- Fix --------------------------------------------------------------------
const appUrl = /Hay un servidor de desarrollo de ESTE worktree en (\S+)/.exec(system)?.[1];
const wrapper = /node "([^"]+e2e-run\.mjs)"/.exec(system)?.[1];
const specPath = /Escribe el spec en "([^"]+)"/.exec(system)?.[1];
const unitWrapper = /node "([^"]+unit-run\.mjs)"/.exec(system)?.[1];
const unitOut = /--out "([^"]+)"/.exec(system)?.[1];

// Reanudación porque el servicio pide el spec de regresión: en "mismatch" se insiste en que no se puede.
if (/spec de regresión verificado/.test(prompt)) {
  say('No puedo cubrirlo con un spec: el rig no tiene runner de tests.');
  finish(json({ status: 'fixed', branch: 'rig', files_changed: ['widget_front/src/labels.js'], tests: 'none', issue: 'i', solution: 's', reproduction: 'reproduced', regression_test: { kind: 'none', reason: 'the rig repo has no unit test runner' } }));
}
if (process.env.RIG_DEBUG) {
  writeFileSync(path.join(cwd, 'rig-debug.txt'), JSON.stringify({ hasSection: system.includes('REPRODUCCIÓN'), appUrl, wrapper, specPath, systemLen: system.length, argvFlags: argv.filter((a) => a.startsWith('--')) }, null, 2));
}
const labels = path.join(cwd, 'src', 'labels.js');
const applyFix = () => writeFileSync(labels, "export const nextLabel = () => 'Threshold 3'; // fix: índice libre\n");

// Spec de regresión DEL REPO, ejecutado con el wrapper del servicio (rojo antes, verde después).
const unitSpec = 'src/labels.spec.mjs';
const writeUnitSpec = () =>
  writeFileSync(
    path.join(cwd, unitSpec),
    `import { nextLabel } from './labels.js';\nif (nextLabel() !== 'Threshold 3') { console.error('FAIL: got ' + nextLabel()); process.exit(1); }\nconsole.log('PASS');\n`,
  );
const runUnit = (phase) => {
  if (!unitWrapper || !unitOut) return -1;
  const args = [unitWrapper, '--phase', phase, '--cwd', cwd, '--out', unitOut, '--spec', unitSpec, '--', 'node', unitSpec];
  tool('Bash', { command: `node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}` });
  const res = spawnSync('node', args, { cwd, encoding: 'utf8' });
  result(`${(res.stdout ?? '').slice(-300)}${(res.stderr ?? '').slice(-200)}`);
  return res.status;
};
const regressionReport = { kind: 'unit', files: [`widget_front/${unitSpec}`] };

const report = (extra = {}) =>
  json({
    status: 'fixed',
    branch: 'rig',
    files_changed: ['widget_front/src/labels.js'],
    // RIG_TESTS_VALUE permite simular valores fuera del contrato (caso real: "e2e").
    tests: process.env.RIG_TESTS_VALUE ?? 'passed',
    tests_detail: '1 passed',
    issue: 'The default label reused an existing name after deleting an item.',
    solution: 'nextLabel() now returns the first free index.',
    ...extra,
  });

if (!appUrl || !wrapper || !specPath || mode === 'codeonly') {
  // Sin entorno: se arregla mirando el código, como pidió el equipo. El spec de regresión sigue siendo obligatorio.
  say('No hay entorno de reproducción; arreglo revisando el código.');
  writeUnitSpec();
  runUnit('before');
  applyFix();
  runUnit('after');
  finish(report({ reproduction: 'not_applicable', regression_test: regressionReport }));
}

// 1) Spec que afirma el comportamiento correcto: con el bug presente, falla.
mkdirSync(path.dirname(specPath), { recursive: true });
writeFileSync(
  specPath,
  `import { test, expect } from '@playwright/test';

test('la nueva etiqueta no repite una existente', async ({ page }) => {
  await page.goto('/html_pages/bug.html');
  await expect(page.locator('#new')).toHaveText('Threshold 3');
});
`,
);
say('Escribo el spec de reproducción y lo ejecuto antes de tocar nada.');

const runPhase = (phase) => {
  tool('Bash', { command: `node ${wrapper} --phase ${phase} ${specPath}` });
  // Sin --url ni BUGS_MANAGER_APP_URL a propósito: el wrapper debe resolverla del manifiesto.
  const res = spawnSync('node', [wrapper, '--phase', phase, specPath], { cwd, encoding: 'utf8' });
  result(`${(res.stdout ?? '').slice(-500)}${(res.stderr ?? '').slice(-300)}`);
  return res.status;
};

const before = runPhase('before');
if (before === 0) {
  finish(json({ status: 'needs_clarification', questions: ['La prueba pasa sin el fix, así que no reproduce el bug. ¿Sigo solo con código?'] }));
}
say('Reproducido: la prueba falla sin el fix. Escribo el spec de regresión y aplico el arreglo.');

// En "mismatch" se toca el archivo pero NO se corrige y no hay spec: el after seguirá rojo aunque
// abajo se afirme lo contrario, y el servicio tendrá que pedir el spec y luego preguntar a una persona.
if (mode === 'mismatch') {
  writeFileSync(labels, readFileSync(labels, 'utf8') + '// tocado sin arreglar\n');
  runPhase('after');
  finish(report({ reproduction: 'reproduced' }));
}

writeUnitSpec();
runUnit('before');
applyFix();
runUnit('after');
runPhase('after');
finish(report({ reproduction: 'reproduced', regression_test: regressionReport }));
