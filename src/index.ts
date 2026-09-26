import express from 'express';
import path from 'node:path';
import { SseHub } from './api/sse.js';
import { ClaudeRunner, DEFAULT_ALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS, parseToolList } from './claude/runner.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { DevServerManager } from './e2e/devserver.js';
import { WorktreeManager } from './git/worktree.js';
import { Intake } from './intake.js';
import { JiraClient } from './jira/client.js';
import { BitbucketClient } from './scm/bitbucket.js';
import { JobRepository } from './jobs/repository.js';
import { JobService } from './jobs/service.js';
import { initLogger } from './logger.js';
import { explainEnvironments, loadEnvironments } from './e2e/harness.js';
import { RepoRegistry, parseRepoOverrides } from './repos/registry.js';
import { mountHttp } from './server.js';
import { createSlackApp } from './slack/app.js';
import { registerSlackHandlers } from './slack/handlers.js';
import { SlackNotifier } from './slack/notifier.js';
import { resolveConfigPath } from './util/paths.js';
import { projectRoot } from './util/project-root.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = initLogger(config.LOG_LEVEL, config.NODE_ENV !== 'production');

  // Persistencia: los jobs en awaiting_* siguen ahí tras un reinicio.
  const db = openDatabase(config.DATABASE_PATH);
  const jobs = new JobService(new JobRepository(db));
  const sse = new SseHub();
  jobs.on('job', (job) => sse.broadcast('job', job));
  jobs.on('message', (message) => sse.broadcast('message', message));

  // Catálogo de repositorios: qrvey_platform_knowledge (manifest, clones, scripts).
  const knowledgePath = resolveConfigPath(config.KNOWLEDGE_REPO_PATH, projectRoot());
  const reposDir = config.REPOS_DIR ? resolveConfigPath(config.REPOS_DIR, projectRoot()) : path.join(knowledgePath, 'repos_product');
  const manifestPath = config.REPOS_MANIFEST ? resolveConfigPath(config.REPOS_MANIFEST, projectRoot()) : path.join(knowledgePath, 'config', 'repos_product.manifest');
  const repos = new RepoRegistry({
    knowledgePath,
    reposDir,
    manifestPath,
    installCommand: config.INSTALL_COMMAND,
    testCommand: config.TEST_COMMAND,
    copyFiles: config.COPY_FILES,
    overrides: new Map(), // se rellena abajo, cuando conocemos los nombres del manifest
    cloneTimeoutMs: config.CLONE_TIMEOUT_MINUTES * 60_000,
    baseDir: projectRoot(),
  });
  const overrides = parseRepoOverrides(process.env, repos.names());
  repos.setOverrides(overrides);
  for (const problem of await repos.check()) log.warn(problem);
  log.info(
    { knowledge: knowledgePath, reposDir, manifest: repos.names().length, cloned: repos.cloned().map((r) => r.name), overrides: [...overrides.keys()] },
    'Catálogo de repositorios cargado',
  );

  const worktrees = new WorktreeManager({
    remote: config.GIT_REMOTE,
    worktreesDir: resolveConfigPath(config.WORKTREES_DIR, projectRoot()),
    branchPrefix: config.BRANCH_PREFIX,
    installTimeoutMs: config.INSTALL_TIMEOUT_MINUTES * 60_000,
  });
  for (const problem of await worktrees.check()) log.warn(problem);
  log.info({ worktreesDir: config.WORKTREES_DIR, remote: config.GIT_REMOTE, install: config.INSTALL_COMMAND ?? '(auto)' }, 'Worktrees configurados');

  const claude = new ClaudeRunner({
    bin: config.CLAUDE_BIN,
    model: config.CLAUDE_MODEL,
    permissionMode: config.CLAUDE_PERMISSION_MODE,
    allowedTools: parseToolList(config.CLAUDE_ALLOWED_TOOLS, DEFAULT_ALLOWED_TOOLS),
    disallowedTools: parseToolList(config.CLAUDE_DISALLOWED_TOOLS, DEFAULT_DISALLOWED_TOOLS),
    settingSources: parseToolList(config.CLAUDE_SETTING_SOURCES, ['user']),
    timeoutMs: config.JOB_TIMEOUT_MINUTES * 60_000,
    idleTimeoutMs: Math.max(config.CLAUDE_IDLE_TIMEOUT_MINUTES, config.CLAUDE_BASH_MAX_TIMEOUT_MINUTES + 1) * 60_000,
    bashTimeoutMs: config.CLAUDE_BASH_MAX_TIMEOUT_MINUTES * 60_000,
  });
  log.info(
    {
      bin: config.CLAUDE_BIN,
      model: config.CLAUDE_MODEL ?? '(por defecto)',
      permissionMode: config.CLAUDE_PERMISSION_MODE,
      timeoutMin: config.JOB_TIMEOUT_MINUTES,
      idleMin: Math.max(config.CLAUDE_IDLE_TIMEOUT_MINUTES, config.CLAUDE_BASH_MAX_TIMEOUT_MINUTES + 1),
      tests: config.TEST_COMMAND ?? '(por repo / ninguno)',
    },
    'Claude Code configurado',
  );
  log.info(
    { allowTransition: config.JIRA_ALLOW_TRANSITION, target: config.JIRA_IN_PROGRESS_STATUS, allowComment: config.JIRA_ALLOW_COMMENT },
    config.JIRA_ALLOW_TRANSITION
      ? 'Jira: se ofrecerá mover el ticket al empezar (siempre con confirmación)'
      : 'Jira: solo lectura (JIRA_ALLOW_TRANSITION=false)',
  );

  const devServers = new DevServerManager(config.DEV_SERVER_TIMEOUT_MINUTES * 60_000);
  const wrapperPath = path.join(projectRoot(), 'bin', 'e2e-run.mjs');
  // Ambientes de datos: todos en un archivo (fuera de git); el .env solo dice cuál usar.
  const environmentsFile = resolveConfigPath(config.E2E_ENVIRONMENTS_FILE, projectRoot());
  const selectedEnvironment = config.E2E_ENV ?? config.E2E_ENV_DEFAULT;
  const environments = [...loadEnvironments(process.env, environmentsFile).keys()];
  log.info(
    {
      enabled: config.E2E_ENABLED,
      environmentsFile,
      environments,
      selected: selectedEnvironment ?? '(ninguno)',
      artifactsDir: config.ARTIFACTS_DIR,
    },
    'Reproducción en navegador configurada',
  );
  // Sin ambiente utilizable, todo job de frontend acabará preguntando en el hilo: mejor avisarlo al arrancar.
  if (config.E2E_ENABLED && (!environments.length || (selectedEnvironment && !environments.includes(selectedEnvironment)))) {
    log.warn({ selected: selectedEnvironment, detail: explainEnvironments(process.env, environmentsFile) }, 'E2E activado pero el ambiente de datos elegido no está disponible');
  }

  const expressApp = express();
  const jira = new JiraClient(config);
  // Pull requests: por defecto con las credenciales de Jira (misma cuenta Atlassian).
  const bitbucket = config.PR_ENABLED
    ? new BitbucketClient({ apiBase: config.BITBUCKET_API_BASE, email: config.BITBUCKET_EMAIL ?? config.JIRA_EMAIL, token: config.BITBUCKET_API_TOKEN ?? config.JIRA_API_TOKEN })
    : undefined;
  log.info(
    { enabled: config.PR_ENABLED, apiBase: config.BITBUCKET_API_BASE, closeSourceBranch: config.PR_CLOSE_SOURCE_BRANCH, waitingForMerge: config.JIRA_WAITING_FOR_MERGE_STATUS ?? '(no se ofrece)' },
    bitbucket ? 'Pull requests: se ofrecerá subir la rama y abrir el PR (con confirmación; nunca push a la rama origen)' : 'Pull requests desactivados (PR_ENABLED=false)',
  );
  const slack = createSlackApp(config, expressApp);
  const notifier = new SlackNotifier(slack.app.client, config.SLACK_CHANNEL_ID);
  const intake = new Intake(jira, notifier, jobs, worktrees, repos, claude, devServers, {
    maxClarificationRounds: config.MAX_CLARIFICATION_ROUNDS,
    regressionRequired: config.REGRESSION_SPEC_REQUIRED,
    dashboardUrl: (config.DASHBOARD_URL ?? config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, ''),
    branchesReferenceRepo: config.BRANCHES_REFERENCE_REPO,
    e2eEnabled: config.E2E_ENABLED,
    artifactsDir: resolveConfigPath(config.ARTIFACTS_DIR, projectRoot()),
    wrapperPath,
    defaultEnvironment: selectedEnvironment,
    environmentsFile,
    jiraAllowTransition: config.JIRA_ALLOW_TRANSITION,
    jiraInProgressStatus: config.JIRA_IN_PROGRESS_STATUS,
    jiraAllowComment: config.JIRA_ALLOW_COMMENT,
    jiraWaitingForMergeStatus: config.JIRA_WAITING_FOR_MERGE_STATUS,
    prEnabled: config.PR_ENABLED,
    prCloseSourceBranch: config.PR_CLOSE_SOURCE_BRANCH,
    commitTemplate: config.COMMIT_MESSAGE_TEMPLATE,
    gitRemote: config.GIT_REMOTE,
    bitbucket,
    bitbucketWorkspace: config.BITBUCKET_WORKSPACE,
  });

  registerSlackHandlers(slack.app, config, intake);
  mountHttp(expressApp, { config, intake, jobs, sse });

  // Recuperar huérfanos ANTES de aceptar peticiones: si no, una respuesta que llegue justo al
  // arrancar relanza Claude y la recuperación la confundiría con una sesión perdida.
  const orphans = await intake.recoverOrphans();
  if (orphans) log.warn({ count: orphans }, 'Jobs en curso marcados como fallidos por reinicio');
  const active = jobs.list().filter((j) => !['fixed', 'cannot_fix', 'failed', 'discarded'].includes(j.status));
  if (active.length) log.info({ count: active.length, tickets: active.map((j) => `${j.ticketKey}:${j.status}`) }, 'Jobs activos recuperados de la base');

  // HTTP después: el dashboard y la API no deben depender de que Slack conecte.
  const server = expressApp.listen(config.PORT, () => {
    log.info(
      { port: config.PORT, slackMode: slack.socketMode ? 'socket' : 'http' },
      `HTTP escuchando en http://localhost:${config.PORT}`,
    );
    if (config.PUBLIC_BASE_URL) {
      if (config.JIRA_WEBHOOK_SECRET) log.info(`Webhook de Jira: ${config.PUBLIC_BASE_URL}/webhooks/jira`);
      if (!slack.socketMode) log.info(`Eventos de Slack: ${config.PUBLIC_BASE_URL}/slack/events`);
    }
  });

  const slackReady = await verifyCredentials(jira, slack.app, config.SLACK_CHANNEL_ID, log);

  // Socket Mode conecta en segundo plano: si el websocket tarda o falla, el servicio sigue
  // sirviendo HTTP y Bolt reintenta solo. Antes esto bloqueaba todo el arranque.
  if (slack.socketMode && slackReady) {
    const started = Date.now();
    const warnTimer = setTimeout(() => log.warn('Slack Socket Mode lleva 30 s sin conectar; Bolt sigue reintentando. Revisa red/VPN o SLACK_APP_TOKEN.'), 30_000);
    slack.app
      .start()
      .then(() => {
        clearTimeout(warnTimer);
        log.info({ ms: Date.now() - started }, 'Slack Socket Mode conectado');
      })
      .catch((err: unknown) => {
        clearTimeout(warnTimer);
        log.error({ err: errMessage(err) }, 'Slack Socket Mode no pudo conectar');
      });
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Apagando…');
    devServers.stopAll();
    // Si Slack no responde (websocket colgado), no esperamos indefinidamente: tsx watch y
    // systemd necesitan que el proceso muera para poder reiniciarlo.
    setTimeout(() => process.exit(0), 3000).unref();
    sse.close();
    server.close();
    if (slack.socketMode) await slack.app.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Comprueba credenciales al arrancar. Avisa pero no aborta: así puedes probar un
 * lado sin el otro. Devuelve true si Slack quedó inicializado.
 */
async function verifyCredentials(
  jira: JiraClient,
  app: ReturnType<typeof createSlackApp>['app'],
  channel: string,
  log: ReturnType<typeof initLogger>,
): Promise<boolean> {
  try {
    const me = await jira.whoAmI();
    log.info({ user: me }, 'Jira: credenciales OK');
  } catch (err) {
    log.warn({ err: errMessage(err) }, 'Jira: no se pudieron validar las credenciales (revisa JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN)');
  }

  try {
    await app.init();
    const auth = await app.client.auth.test();
    log.info({ bot: auth.user, team: auth.team }, 'Slack: bot token OK');
    try {
      const info = await app.client.conversations.info({ channel });
      if (!info.channel?.is_member) {
        log.warn({ channel }, `Slack: el bot NO está en el canal. Invítalo con /invite @${auth.user ?? 'bot'}`);
      } else {
        log.info({ channel: info.channel.name }, 'Slack: el bot es miembro del canal');
      }
    } catch (err) {
      log.warn({ channel, err: errMessage(err) }, 'Slack: no se pudo leer el canal (revisa SLACK_CHANNEL_ID y el scope groups:read)');
    }
    return true;
  } catch (err) {
    log.error({ err: errMessage(err) }, 'Slack: bot token inválido (revisa SLACK_BOT_TOKEN). Slack queda deshabilitado; solo responde HTTP.');
    return false;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fallo fatal al arrancar:', err);
  process.exit(1);
});
