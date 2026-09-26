#!/usr/bin/env node
/**
 * Prueba de humo de extremo a extremo, sin Jira, sin Slack y sin gastar tokens:
 * monta el banco de pruebas, arranca el servicio contra una base temporal y
 * recorre los escenarios de la reproducción en navegador.
 *
 *   pnpm smoke            # todos los escenarios
 *   pnpm smoke happy      # solo uno
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRig } from './rig.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RIG = path.join(ROOT, '.rig');
const PORT = 3999;
const BB_PORT = 39996; // Bitbucket falso
const bbRequests = [];
const API = `http://localhost:${PORT}/api`;
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, init) {
  try {
    const res = await fetch(`${API}${pathname}`, { headers: { 'content-type': 'application/json' }, ...init });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  } catch {
    return { status: 0, body: undefined }; // el servicio aún no escucha
  }
}

/** Crea un job ya con rama elegida, como si Slack hubiera hecho su parte. */
function seedJob(dbPath, key) {
  const code = `
import { initLogger } from '${ROOT}/src/logger.ts';
import { openDatabase } from '${ROOT}/src/db/index.ts';
import { JobRepository } from '${ROOT}/src/jobs/repository.ts';
import { JobService } from '${ROOT}/src/jobs/service.ts';
initLogger('silent', false);
const svc = new JobService(new JobRepository(openDatabase(${JSON.stringify(dbPath)})));
const j = svc.create({ key: ${JSON.stringify(key)}, source: 'manual', requestedBy: 'rig' });
svc.setTicket(j.id, { key: ${JSON.stringify(key)}, summary: 'etiqueta duplicada', description: 'al borrar y añadir se repite', status: 'Open', statusCategory: 'new', issueType: 'Bug', projectKey: 'AN', reporter: 'QA', url: 'http://x', comments: [] });
svc.ask(j.id, 'awaiting_branch', 'rama?');
console.log(j.id);
`;
  const res = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['-e', code], { encoding: 'utf8' });
  const id = (res.stdout ?? '').trim().split('\n').pop();
  if (!id) throw new Error(`no pude sembrar el job: ${res.stderr}`);
  return id;
}

function startService(rig, extraEnv) {
  // Ambientes como en producción: un archivo con todos y E2E_ENV eligiendo uno.
  const environmentsFile = path.join(RIG, 'environments.json');
  writeFileSync(
    environmentsFile,
    JSON.stringify({ demo: { domain: 'https://example.com', api_key: 'rig-key', app_id: 'rig-app', user_id: 'rig-user', qrveyid: 'rig-asset' } }, null, 2),
  );
  const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      PORT: String(PORT),
      DATABASE_PATH: path.join(RIG, 'smoke.db'),
      // Jira y Slack apuntan a la nada: el rig no los necesita.
      JIRA_BASE_URL: 'http://127.0.0.1:1',
      JIRA_EMAIL: 'rig@test.com',
      JIRA_API_TOKEN: 'x',
      JIRA_WEBHOOK_SECRET: '',
      SLACK_BOT_TOKEN: 'xoxb-rig',
      SLACK_SIGNING_SECRET: 'rig',
      SLACK_SOCKET_MODE: 'false',
      PUBLIC_BASE_URL: 'https://rig.example.com',
      SLACK_CHANNEL_ID: 'C0RIG',
      KNOWLEDGE_REPO_PATH: rig.knowledge,
      WORKTREES_DIR: rig.worktrees,
      ARTIFACTS_DIR: rig.artifacts,
      BRANCH_PREFIX: 'bugfix/',
      INSTALL_COMMAND: 'true',
      COPY_FILES: '',
      CLAUDE_BIN: path.join(ROOT, 'scripts', 'dev', 'fake-claude.mjs'),
      CLAUDE_MODEL: '',
      E2E_ENABLED: 'true',
      DEV_SERVER_TIMEOUT_MINUTES: '1',
      E2E_ENVIRONMENTS_FILE: environmentsFile,
      E2E_ENV: 'demo',
      PR_ENABLED: 'false',
      ...extraEnv,
    },
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));
  return { child, getLog: () => log };
}

async function waitFor(fn, timeoutMs, label, getLog) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(700);
  }
  if (getLog) console.log(`\n--- log del servicio ---\n${getLog().split('\n').slice(-30).join('\n')}\n---`);
  throw new Error(`timeout esperando ${label}`);
}

async function runScenario(name, { env = {}, expect: expected }) {
  if (only.length && !only.includes(name)) return;
  console.log(`\n=== ${name}`);
  rmSync(path.join(RIG, 'smoke.db'), { force: true });
  rmSync(path.join(RIG, 'smoke.db-wal'), { force: true });
  rmSync(path.join(RIG, 'smoke.db-shm'), { force: true });
  const rig = buildRig(RIG);
  const jobId = seedJob(path.join(RIG, 'smoke.db'), 'AN-1');
  const svc = startService(rig, env);
  try {
    await waitFor(async () => (await api('/meta')).status === 200, 60_000, 'que el servicio arranque', svc.getLog);
    await api(`/jobs/${jobId}/answer`, { method: 'POST', body: JSON.stringify({ answer: 'develop' }) });
    const afterTriage = await waitFor(
      async () => {
        const { body } = await api(`/jobs/${jobId}`);
        return body?.status === 'awaiting_repos' ? body : undefined;
      },
      120_000,
      'el triaje',
      svc.getLog,
    );
    check('el triaje propone repos', afterTriage.triageResult?.repos?.length > 0, afterTriage.triageResult?.repos?.[0]?.name);
    await api(`/jobs/${jobId}/repos`, { method: 'POST', body: JSON.stringify({ action: 'confirm' }) });

    const done = await waitFor(
      async () => {
        const { body } = await api(`/jobs/${jobId}`);
        return ['fixed', 'failed', 'cannot_fix', 'discarded'].includes(body?.status) || body?.e2eMode === 'awaiting_env' || body?.regressionTest?.verdict === 'pending'
          ? body
          : undefined;
      },
      300_000,
      'el resultado del job',
      svc.getLog,
    );
    await expected(done, jobId, svc, rig);
  } finally {
    svc.child.kill('SIGTERM');
    await sleep(1500);
    spawnSync('pkill', ['-f', 'scripts/dev/.*server.mjs'], { stdio: 'ignore' });
  }
}

/**
 * Bitbucket falso: guarda lo que recibe y responde como la API real (lista vacía en GET,
 * PR #7 en POST). Suficiente para comprobar que el servicio pide el PR correcto.
 */
function fakeBitbucket(port) {
  const srv = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        parsed = undefined;
      }
      bbRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: parsed });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') {
        res.end(JSON.stringify({ values: [] }));
        return;
      }
      if (req.method === 'POST') {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 7, title: parsed?.title, links: { html: { href: 'https://bitbucket.org/rig/widget_front/pull-requests/7' } }, destination: parsed?.destination }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(port, () => resolve(srv)));
}

const isAwaitingStatus = (s) => typeof s === 'string' && s.startsWith('awaiting_');

/**
 * Dos jobs del MISMO repositorio a la vez: antes un lock por repo hacía que el segundo preguntara
 * "otro job ya tiene levantado el servidor". Ahora cada uno levanta el suyo en su worktree.
 */
async function runParallelScenario() {
  const name = 'dos-jobs-mismo-repo';
  if (only.length && !only.includes(name)) return;
  console.log(`\n=== ${name}`);
  for (const f of ['smoke.db', 'smoke.db-wal', 'smoke.db-shm']) rmSync(path.join(RIG, f), { force: true });
  const rig = buildRig(RIG);
  const ids = [seedJob(path.join(RIG, 'smoke.db'), 'AN-1'), seedJob(path.join(RIG, 'smoke.db'), 'AN-2')];
  const svc = startService(rig, { RIG_MODE: 'happy' });
  try {
    await waitFor(async () => (await api('/meta')).status === 200, 60_000, 'que el servicio arranque', svc.getLog);
    for (const id of ids) await api(`/jobs/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer: 'develop' }) });
    for (const id of ids) {
      await waitFor(async () => (await api(`/jobs/${id}`)).body?.status === 'awaiting_repos', 120_000, `el triaje de ${id.slice(0, 8)}`, svc.getLog);
      await api(`/jobs/${id}/repos`, { method: 'POST', body: JSON.stringify({ action: 'confirm' }) });
    }
    const done = await Promise.all(
      ids.map((id) =>
        waitFor(
          async () => {
            const { body } = await api(`/jobs/${id}`);
            return ['fixed', 'failed', 'cannot_fix', 'discarded'].includes(body?.status) || body?.e2eMode === 'awaiting_env' ? body : undefined;
          },
          300_000,
          `el resultado de ${id.slice(0, 8)}`,
          svc.getLog,
        ),
      ),
    );
    check('los dos jobs terminan en fixed', done.every((j) => j.status === 'fixed'), done.map((j) => `${j.ticketKey}:${j.status}${j.failureReason ? ` (${j.failureReason})` : ''}`).join(', '));
    check('ninguno esperó por el otro (los dos con entorno)', done.every((j) => j.e2eMode === 'e2e'), done.map((j) => j.e2eMode).join(', '));
    check('cada job tuvo su propio servidor', Boolean(done[0].appUrl && done[1].appUrl) && done[0].appUrl !== done[1].appUrl, `${done[0].appUrl} / ${done[1].appUrl}`);
    check('los dos verificados rojo → verde', done.every((j) => /verified/.test(j.reproduction ?? '')), done.map((j) => j.reproduction).join(' | '));
  } finally {
    svc.child.kill('SIGTERM');
    await sleep(1500);
    spawnSync('pkill', ['-f', 'scripts/dev/.*server.mjs'], { stdio: 'ignore' });
  }
}

/** Ocupa un puerto para simular otro proyecto corriendo en la máquina. */
function occupy(port) {
  const srv = createServer(() => {});
  return new Promise((resolve) => srv.listen(port, () => resolve(srv)));
}

async function main() {
  mkdirSync(RIG, { recursive: true });

  await runScenario('happy', {
    env: { RIG_MODE: 'happy', RIG_TESTS_VALUE: 'e2e' }, // "e2e" no está en el contrato: debe normalizarse, no tumbar el job
    expect: async (job, jobId, _svc, rig) => {
      check('el job termina en fixed', job.status === 'fixed', job.status + (job.failureReason ? `: ${job.failureReason}` : ''));
      check('tests:"e2e" se normaliza a none con nota', job.testsResult === 'none' && /reported as "e2e"/.test(job.testsDetail ?? ''), `${job.testsResult} — ${job.testsDetail}`);
      check('el spec de regresión queda verificado rojo → verde', job.regressionTest?.verdict === 'verified', job.regressionTest?.label ?? '(sin veredicto)');
      check('el spec cuenta como archivo del fix', (job.filesChanged ?? []).some((f) => f.endsWith('src/labels.spec.mjs')), (job.filesChanged ?? []).join(', '));
      check('la reproducción queda verificada', /verified/.test(job.reproduction ?? ''), job.reproduction ?? '(vacío)');
      check('el reporte trae Issue y Solution', Boolean(job.issue && job.solution));
      const { body: arts } = await api(`/jobs/${jobId}/artifacts`);
      const videos = Array.isArray(arts) ? arts.filter((a) => a.kind === 'video') : [];
      check('hay vídeo de antes y de después', videos.length >= 2, `${videos.length} vídeos, ${arts.length} artefactos`);
      if (videos[0]) {
        const res = await fetch(`${API}/jobs/${jobId}/artifacts/${videos[0].id}`);
        const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0;
        check('la API sirve el vídeo', res.ok && bytes > 1000, `HTTP ${res.status}, ${bytes} bytes`);
      }
      check('el spec no cuenta como archivo del fix', !(job.filesChanged ?? []).some((f) => f.includes('.bugs-manager')), (job.filesChanged ?? []).join(', '));
      const e2eDir = path.join(rig.artifacts, jobId, 'e2e');
      check('el manifiesto del wrapper está junto al spec', existsSync(path.join(e2eDir, 'bugs-manager.json')));
      check('node_modules enlazado junto al spec desde el arranque', existsSync(path.join(e2eDir, 'node_modules', '@playwright', 'test', 'package.json')));
      const { body: detail } = await api(`/jobs/${jobId}`);
      const ready = (detail.events ?? []).find((e) => /Entorno de reproducción listo/.test(e.message));
      check('el harness se comprobó servido (HTTP 200) antes de arrancar la sesión', /harness servido en/.test(ready?.message ?? ''), ready?.message ?? '(sin evento)');
    },
  });

  // Como Stencil: el servidor sirve una copia (www/) que se reconstruye unos segundos después de
  // cada cambio. Sin la espera del wrapper, la fase "after" mediría el bundle viejo (bug presente).
  await runScenario('rebuild-lento', {
    env: { RIG_MODE: 'happy', RIG_BUILD_DELAY_MS: '4000' },
    expect: async (job, jobId, _svc, rig) => {
      check('el job termina en fixed', job.status === 'fixed', job.status + (job.failureReason ? `: ${job.failureReason}` : ''));
      check('verificado aunque la reconstrucción tarde', /verified/.test(job.reproduction ?? ''), job.reproduction ?? '(vacío)');
      const e2eDir = path.join(rig.artifacts, jobId, 'e2e');
      let waits = {};
      try {
        waits = JSON.parse(readFileSync(path.join(e2eDir, 'after', 'wrapper.json'), 'utf8'));
      } catch {
        /* sin registro de esperas */
      }
      check('el wrapper esperó a la reconstrucción en la fase after', (waits.rebuild?.waitedMs ?? 0) >= 2000 && waits.rebuild?.timedOut === false, JSON.stringify(waits.rebuild ?? null));
      const { body: detail } = await api(`/jobs/${jobId}`);
      const wt = (detail.worktrees ?? [])[0]?.worktreePath;
      check('el harness fue directo al directorio servido (www/)', Boolean(wt) && existsSync(path.join(wt, 'www', 'html_pages', '_bugs-manager-harness.html')), wt ?? '(sin worktree)');
      const ready = (detail.events ?? []).find((e) => /Entorno de reproducción listo/.test(e.message));
      check('y se comprobó servido antes de arrancar', /harness servido en/.test(ready?.message ?? ''), ready?.message ?? '(sin evento)');
    },
  });

  // Cierre del ciclo: commit con plantilla, push de la rama con su nombre, PR hacia la rama origen.
  await runScenario('pull-request', {
    env: {
      RIG_MODE: 'happy',
      PR_ENABLED: 'true',
      BITBUCKET_API_BASE: `http://localhost:${BB_PORT}/2.0`,
      BITBUCKET_WORKSPACE: 'rig',
      BITBUCKET_EMAIL: 'rig@test.com',
      BITBUCKET_API_TOKEN: 'rig-token',
      JIRA_WAITING_FOR_MERGE_STATUS: '', // Jira no existe en el rig
    },
    expect: async (job, jobId) => {
      check('el job termina en fixed', job.status === 'fixed', job.status + (job.failureReason ? `: ${job.failureReason}` : ''));
      bbRequests.length = 0;
      const remote = path.join(RIG, 'remotes', 'widget_front.git');
      const gitRemote = (...args) => spawnSync('git', ['-C', remote, ...args], { encoding: 'utf8' }).stdout.trim();
      const developBefore = gitRemote('rev-parse', 'develop');

      const opened = await api(`/jobs/${jobId}/pull-request`, { method: 'POST', body: JSON.stringify({ action: 'open' }) });
      check('la API acepta abrir el PR', opened.status === 200, `HTTP ${opened.status} ${JSON.stringify(opened.body).slice(0, 200)}`);
      const { body: detail } = await api(`/jobs/${jobId}`);
      const wt = (detail.worktrees ?? [])[0] ?? {};
      check('el worktree registra el PR', /pull-requests\/7$/.test(wt.prUrl ?? ''), wt.prUrl ?? '(sin prUrl)');
      check('la rama bugfix/… está en el remoto', gitRemote('branch', '--list', wt.branch ?? 'x') !== '', gitRemote('branch', '--list', 'bugfix/*'));
      check('la rama origen NO se tocó', gitRemote('rev-parse', 'develop') === developBefore);
      const subject = gitRemote('log', '-1', '--format=%s', wt.branch ?? 'develop');
      check('el commit sigue la plantilla', subject === 'fix(AN-1): :bug: etiqueta duplicada', subject);
      const post = bbRequests.find((r) => r.method === 'POST');
      check(
        'Bitbucket recibió el PR bugfix → develop sin merge',
        Boolean(post) && post.body?.source?.branch?.name === wt.branch && post.body?.destination?.branch?.name === 'develop' && post.body?.close_source_branch === true && /^Basic /.test(post.auth ?? ''),
        post ? `${post.url} · ${JSON.stringify(post.body?.source)} → ${JSON.stringify(post.body?.destination)}` : 'sin POST',
      );
      check('la descripción del PR lleva la plantilla QA', /\*\*Issue:\*\*/.test(post?.body?.description ?? '') && /\*\*Solution:\*\*/.test(post?.body?.description ?? ''));
      check('queda el evento pr_opened', (detail.events ?? []).some((e) => e.type === 'pr_opened'));
      const again = await api(`/jobs/${jobId}/pull-request`, { method: 'POST', body: JSON.stringify({ action: 'open' }) });
      check('no abre un segundo PR', again.status >= 400 && /ya está abierto/.test(JSON.stringify(again.body)), `HTTP ${again.status}`);
    },
  });

  await runScenario('mismatch', {
    env: { RIG_MODE: 'mismatch' },
    expect: async (job, jobId) => {
      // Sin spec de regresión: primero se le pide a Claude, después decide una persona.
      check('el fix sin spec no se da por solucionado: espera decisión humana', job.status === 'awaiting_clarification' && job.regressionTest?.verdict === 'pending', `${job.status} / ${job.regressionTest?.verdict}`);
      const { body: before } = await api(`/jobs/${jobId}`);
      check('se le pidió el spec a Claude una vez', (before.events ?? []).some((e) => e.type === 'regression_requested'));
      const accepted = await api(`/jobs/${jobId}/regression`, { method: 'POST', body: JSON.stringify({ action: 'accept' }) });
      check('la API acepta el fix sin spec', accepted.status === 200, `HTTP ${accepted.status} ${JSON.stringify(accepted.body).slice(0, 120)}`);
      const done = await waitFor(
        async () => {
          const { body } = await api(`/jobs/${jobId}`);
          return ['fixed', 'failed', 'cannot_fix', 'discarded'].includes(body?.status) ? body : undefined;
        },
        120_000,
        'el cierre tras aceptar sin spec',
      );
      check('el job termina en fixed marcado sin spec', done.status === 'fixed' && done.regressionTest?.verdict === 'accepted', `${done.status} / ${done.regressionTest?.label}`);
      check('no se da por verificado si la prueba sigue roja', !/^verified/.test(done.reproduction ?? ''), done.reproduction ?? '(vacío)');
      const flagged = (done.events ?? []).some((e) => e.type === 'verification_mismatch');
      check('queda registrada la discrepancia', flagged);
    },
  });

  await runScenario('sin-dev-server', {
    env: { RIG_MODE: 'happy', RIG_NEVER_STARTS: '1' },
    expect: async (job, jobId) => {
      check('pregunta qué hacer sin entorno', job.e2eMode === 'awaiting_env', `e2eMode=${job.e2eMode}`);
      // "Reintentar entorno" con el servidor aún roto: vuelve a preguntar, ni se cuelga ni avanza a ciegas.
      const retried = await api(`/jobs/${jobId}/env`, { method: 'POST', body: JSON.stringify({ action: 'retry' }) });
      check('la API acepta el reintento', retried.status === 200, `HTTP ${retried.status}`);
      const asked = await waitFor(
        async () => {
          const { body } = await api(`/jobs/${jobId}`);
          const n = (body?.events ?? []).filter((e) => /Entorno de reproducción no disponible/.test(e.message)).length;
          return n >= 2 && body.e2eMode === 'awaiting_env' ? body : undefined;
        },
        90_000,
        'el reintento del entorno',
      );
      check('si el servidor sigue sin arrancar, el reintento vuelve a preguntar', asked.e2eMode === 'awaiting_env' && isAwaitingStatus(asked.status), `${asked.status} / ${asked.e2eMode}`);
      await api(`/jobs/${jobId}/env`, { method: 'POST', body: JSON.stringify({ action: 'code_only' }) });
      const done = await waitFor(
        async () => {
          const { body } = await api(`/jobs/${jobId}`);
          return ['fixed', 'failed', 'cannot_fix'].includes(body?.status) ? body : undefined;
        },
        120_000,
        'el fix sin entorno',
      );
      check('con "solo código" el fix sigue adelante', done.status === 'fixed', done.status);
      check('se anota que no hubo reproducción', /code only|not run/i.test(done.reproduction ?? ''), done.reproduction ?? '');
    },
  });

  await runScenario('puerto-ajeno', {
    env: { RIG_MODE: 'happy', RIG_LIE_PORT: '39997' },
    expect: async (job, jobId, svc) => {
      check('no prueba contra un servidor ajeno', job.e2eMode === 'awaiting_env', `e2eMode=${job.e2eMode}`);
      check('el motivo nombra el puerto ocupado', /puerto 39997/.test(svc.getLog() + (job.pendingQuestion ?? '')), job.pendingQuestion ?? '');
      await api(`/jobs/${jobId}/env`, { method: 'POST', body: JSON.stringify({ action: 'discard' }) });
    },
  });

  await runParallelScenario();

  console.log(failures ? `\n${failures} comprobación(es) fallidas` : '\nTodo correcto');
  process.exit(failures ? 1 : 0);
}

let occupied;
let bitbucket;
try {
  occupied = await occupy(39997); // el "otro proyecto" del escenario puerto-ajeno
  bitbucket = await fakeBitbucket(BB_PORT);
  await main();
} finally {
  occupied?.close();
  bitbucket?.close();
}
