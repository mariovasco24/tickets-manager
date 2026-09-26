import 'dotenv/config';
import { z } from 'zod';

const csv = z
  .string()
  .default('Bug')
  .transform((s) =>
    s
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    PUBLIC_BASE_URL: z.url().optional(),
    /** URL con la que TÚ abres el dashboard (para los enlaces desde Slack). Si falta: PUBLIC_BASE_URL o localhost. */
    DASHBOARD_URL: z.url().optional(),

    // Persistencia y dashboard
    DATABASE_PATH: z.string().min(1).default('./data/bugs-manager.db'),
    // Vacíos en local = sin auth. Rellenar ambos en el VPS.
    DASHBOARD_BASIC_AUTH_USER: z.string().optional().transform((s) => s?.trim() || undefined),
    DASHBOARD_BASIC_AUTH_PASSWORD: z.string().optional().transform((s) => s?.trim() || undefined),

    // Jira (solo lectura)
    JIRA_BASE_URL: z.url(),
    JIRA_EMAIL: z.email(),
    JIRA_API_TOKEN: z.string().min(1),
    // Opcional: requiere admin de Jira para registrar el webhook. Si falta, la ruta no se monta.
    JIRA_WEBHOOK_SECRET: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.union([z.literal(''), z.string().min(16, 'usa un secreto de al menos 16 caracteres')]))
      .optional()
      .transform((s) => (s ? s : undefined)),
    JIRA_BUG_ISSUE_TYPES: csv,
    /**
     * Única escritura permitida en Jira: mover el ticket a "en curso" al empezar.
     * Siempre se pregunta antes; si respondes que no, Jira no se toca.
     */
    JIRA_ALLOW_TRANSITION: z.stringbool().default(true),
    /** Estado destino al arrancar el trabajo, tal como se llama en tu flujo de Jira. */
    JIRA_IN_PROGRESS_STATUS: z.string().min(1).default('In Progress'),
    /** Ofrecer publicar el reporte del fix como comentario en el ticket, con los vídeos adjuntos. */
    JIRA_ALLOW_COMMENT: z.stringbool().default(true),
    /** Tras abrir el PR se ofrece mover el ticket a este estado (vacío = no se ofrece). Siempre con confirmación. */
    JIRA_WAITING_FOR_MERGE_STATUS: z
      .string()
      .default('Waiting for Merge')
      .transform((s) => s.trim() || undefined),

    // Pull request (Bitbucket Cloud). Siempre con confirmación; NUNCA push a la rama origen ni merge.
    PR_ENABLED: z.stringbool().default(true),
    PR_CLOSE_SOURCE_BRANCH: z.stringbool().default(true),
    /** {key} y {summary} (título del ticket, primera letra en minúscula). */
    COMMIT_MESSAGE_TEMPLATE: z.string().min(1).default('fix({key}): :bug: {summary}'),
    BITBUCKET_API_BASE: z.url().default('https://api.bitbucket.org/2.0'),
    /** Por defecto las credenciales de Jira (misma cuenta Atlassian). */
    BITBUCKET_EMAIL: z.string().optional().transform((s) => s?.trim() || undefined),
    BITBUCKET_API_TOKEN: z.string().optional().transform((s) => s?.trim() || undefined),
    /** Workspace a usar cuando el remoto no es una URL de bitbucket.org (slug = nombre del repo). */
    BITBUCKET_WORKSPACE: z.string().optional().transform((s) => s?.trim() || undefined),

    // Repositorios y worktrees (fases 3 y 5)
    /** Clon de qrvey_platform_knowledge: catálogo de repos, manifest y scripts de clonado. */
    KNOWLEDGE_REPO_PATH: z.string().min(1, 'ruta del clon de qrvey_platform_knowledge'),
    /** Dónde viven los clones de producto. Por defecto <KNOWLEDGE_REPO_PATH>/repos_product. */
    REPOS_DIR: z.string().optional().transform((s) => s?.trim() || undefined),
    /** Manifest con los nombres canónicos. Por defecto <KNOWLEDGE_REPO_PATH>/config/repos_product.manifest. */
    REPOS_MANIFEST: z.string().optional().transform((s) => s?.trim() || undefined),
    /** Repo ya clonado contra el que se listan/validan las ramas del desplegable. Por defecto, el primero clonado. */
    BRANCHES_REFERENCE_REPO: z.string().optional().transform((s) => s?.trim() || undefined),
    GIT_REMOTE: z.string().min(1).default('origin'),
    WORKTREES_DIR: z.string().min(1, 'directorio donde crear los worktrees'),
    BRANCH_PREFIX: z.string().default('fix/'),
    /** Vacío = autodetectar (package-lock → npm ci; package.json → npm install; nada → no instalar). */
    INSTALL_COMMAND: z.string().optional().transform((s) => s?.trim() || undefined),
    INSTALL_TIMEOUT_MINUTES: z.coerce.number().positive().default(15),
    CLONE_TIMEOUT_MINUTES: z.coerce.number().positive().default(20),
    /** "origen:destino,…" aplicado a todos los repos; admite {repo}. Override por repo: REPO_<NOMBRE>_COPY_FILES. */
    COPY_FILES: z.string().optional().transform((s) => s?.trim() || undefined),

    // Claude Code headless (fase 4)
    CLAUDE_BIN: z.string().min(1).default('claude'),
    CLAUDE_MODEL: z.string().optional().transform((s) => s?.trim() || undefined),
    CLAUDE_PERMISSION_MODE: z.enum(['acceptEdits', 'default', 'dontAsk', 'bypassPermissions', 'plan', 'auto']).default('acceptEdits'),
    /** Comando de tests que Claude debe ejecutar antes de declarar el fix. Vacío = sin tests. */
    TEST_COMMAND: z.string().optional().transform((s) => s?.trim() || undefined),
    /** Sobrescriben la lista por defecto (separados por coma). Ver src/claude/runner.ts. */
    /** Fuentes de settings que carga Claude Code: user, project, local (separadas por coma). */
    CLAUDE_SETTING_SOURCES: z.string().default('user'),
    CLAUDE_ALLOWED_TOOLS: z.string().optional().transform((s) => s?.trim() || undefined),
    CLAUDE_DISALLOWED_TOOLS: z.string().optional().transform((s) => s?.trim() || undefined),
    /** Tope absoluto por ejecución. Red de seguridad: un bug difícil puede llevar una hora de trabajo real. */
    JOB_TIMEOUT_MINUTES: z.coerce.number().positive().default(120),
    /** Sin ninguna salida de Claude Code durante este tiempo se considera colgado. Debe superar el tope de Bash. */
    CLAUDE_IDLE_TIMEOUT_MINUTES: z.coerce.number().positive().default(10),
    /** Tope por comando Bash dentro de la sesión de Claude Code. */
    CLAUDE_BASH_MAX_TIMEOUT_MINUTES: z.coerce.number().positive().default(5),

    // Reproducción en navegador (Playwright)
    E2E_ENABLED: z.stringbool().default(true),
    DEV_SERVER_TIMEOUT_MINUTES: z.coerce.number().positive().default(10),
    ARTIFACTS_DIR: z.string().min(1).default('./data/artifacts'),
    /** Archivo JSON con TODOS los ambientes de datos (fuera de git: lleva api_keys). */
    E2E_ENVIRONMENTS_FILE: z.string().min(1).default('./environments.json'),
    /** Ambiente a usar, por su nombre en el archivo. Cambiarlo y reiniciar basta para probar contra otro. */
    E2E_ENV: z.string().optional().transform((s) => s?.trim() || undefined),
    /** Esquema antiguo por variables (aún admitido): "demo,staging" + E2E_ENV_<NOMBRE>_*. */
    E2E_ENVS: z.string().optional().transform((s) => s?.trim() || undefined),
    /** Alias antiguo de E2E_ENV. */
    E2E_ENV_DEFAULT: z.string().optional().transform((s) => s?.trim() || undefined),
    MAX_CLARIFICATION_ROUNDS: z.coerce.number().int().nonnegative().default(3),
    /** Cada fix debe traer un spec del repo verificado rojo → verde; si Claude no puede, decide una persona. */
    REGRESSION_SPEC_REQUIRED: z.stringbool().default(true),

    // Slack
    SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
    SLACK_SIGNING_SECRET: z.string().min(1),
    SLACK_SOCKET_MODE: z.stringbool().default(true),
    SLACK_APP_TOKEN: z.string().startsWith('xapp-').optional(),
    SLACK_CHANNEL_ID: z.string().regex(/^[CG][A-Z0-9]+$/, 'debe ser un ID de canal (C… o G…), no el nombre'),
  })
  .superRefine((c, ctx) => {
    if (c.SLACK_SOCKET_MODE && !c.SLACK_APP_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['SLACK_APP_TOKEN'],
        message: 'requerido cuando SLACK_SOCKET_MODE=true (token xapp-… con scope connections:write)',
      });
    }
    if (!c.SLACK_SOCKET_MODE && !c.PUBLIC_BASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'recomendado cuando SLACK_SOCKET_MODE=false: es la URL que registras en Slack y Jira',
      });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    // eslint-disable-next-line no-console
    console.error(`Configuración inválida. Revisa tu .env (usa .env.example como guía):\n${lines.join('\n')}`);
    process.exit(1);
  }
  return result.data;
}
