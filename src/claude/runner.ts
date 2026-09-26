import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';

export interface RunnerConfig {
  bin: string;
  model: string | undefined;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** Fuentes de settings de Claude Code que se cargan (user, project, local). Por defecto solo "user". */
  settingSources: string[];
  /** Tope absoluto de una ejecución (inicio o reanudación). */
  timeoutMs: number;
  /** Sin ninguna línea de salida durante este tiempo se considera colgada y se mata. Debe superar bashTimeoutMs. */
  idleTimeoutMs: number;
  /** Tope por comando Bash dentro de la sesión (BASH_MAX_TIMEOUT_MS): acota una espera mal hecha. */
  bashTimeoutMs: number;
}

/**
 * Protección que se inyecta vía --settings en cada sesión: el worktree recibe el
 * .env real, así que Claude no debe poder leer secretos aunque el repo no lo
 * prohíba (al ignorar los settings del proyecto, sus reglas de deny no aplican).
 */
export const PROTECTED_READ_DENY = [
  'Read(.env)',
  'Read(.env.*)',
  'Read(**/.env)',
  'Read(**/.env.*)',
  'Read(**/*.pem)',
  'Read(**/*.key)',
  'Read(**/*.p12)',
  'Read(**/*.pfx)',
  'Read(**/*.jks)',
  'Read(**/id_rsa*)',
  'Read(**/id_ed25519*)',
  'Read(**/.npmrc)',
  'Read(**/credentials.json)',
  'Read(**/service-account*.json)',
  'Read(**/secrets/**)',
];

/** Directorios a los que la sesión accede además del cwd. */
export interface SessionAccess {
  /** Otros worktrees del mismo job: lectura y edición. */
  writableDirs?: string[];
  /** Repo de conocimiento y clones de referencia: solo lectura (se deniega Edit/Write dentro). */
  readOnlyDirs?: string[];
}

/** Evento crudo del `--output-format stream-json` de Claude Code. */
export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>> | string;
  };
  // campos del evento "result"
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  [k: string]: unknown;
}

export interface RunOutcome {
  sessionId: string;
  /** Texto final del asistente (evento result). Vacío si el proceso murió antes. */
  resultText: string;
  isError: boolean;
  errorReason?: string;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  numTurns?: number;
  costUsd?: number;
  stderrTail: string;
}

export interface RunHandle {
  sessionId: string;
  done: Promise<RunOutcome>;
  kill: (reason: string) => void;
}

/**
 * Herramientas permitidas por defecto con acceptEdits: edición libre de
 * archivos y un Bash acotado a npm/npx/node, tests y git de solo lectura.
 * Cualquier otro comando Bash se deniega automáticamente en headless.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'Bash(npm test*)',
  'Bash(npm run *)',
  'Bash(npm ls*)',
  'Bash(npx *)',
  'Bash(node *)',
  // git de solo lectura
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git blame*)',
  'Bash(git grep*)',
  'Bash(git ls-files*)',
  'Bash(git rev-parse*)',
  'Bash(git stash list*)',
  'Bash(git check-ignore*)',
  'Bash(git remote -v*)',
  'Bash(git describe*)',
  // utilidades de texto y archivos. Claude encadena comandos con "|" y Claude Code exige
  // que CADA tramo esté permitido, así que sin estas cada tubería se deniega.
  'Bash(ls*)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(grep *)',
  'Bash(rg *)',
  'Bash(find *)',
  'Bash(sed *)',
  'Bash(awk *)',
  'Bash(wc *)',
  'Bash(sort *)',
  'Bash(uniq *)',
  'Bash(cut *)',
  'Bash(tr *)',
  'Bash(diff *)',
  'Bash(echo *)',
  'Bash(pwd)',
  'Bash(which *)',
  'Bash(jq *)',
  'Bash(curl *)',
  'Bash(printenv*)',
  'Bash(env)',
  // sleep NO está a propósito: sin él no hay bucles "until …; do sleep 5; done". Todo lo que hay que
  // esperar (servidor, reconstrucción en watch) lo espera el wrapper de Playwright.
  'Bash(test *)',
  'Bash(basename *)',
  'Bash(dirname *)',
  'Bash(realpath *)',
  // para ejecutar tests/instalaciones en otro worktree del mismo job ("cd <wt> && npm test")
  'Bash(cd *)',
];

export const DEFAULT_DISALLOWED_TOOLS = [
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(git checkout*)',
  'Bash(git switch*)',
  'Bash(git reset*)',
  'Bash(git rebase*)',
  'Bash(git merge*)',
  'Bash(git stash*)',
  'Bash(git branch*)',
  'Bash(git worktree*)',
  'Bash(rm *)',
  'Bash(sudo *)',
  'WebFetch',
  'WebSearch',
  // Herramientas de sesión interactiva: en headless dejan el proceso vivo esperando un
  // "despertar" que no llega, y el reporte se pierde. Los tests van en primer plano.
  'Monitor',
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'TaskStop',
];

/**
 * Lanza `claude -p` en modo headless con salida stream-json y entrega cada
 * evento según llega. Un proceso por llamada; `resume` reanuda la misma sesión.
 */
export class ClaudeRunner {
  private readonly running = new Map<string, ChildProcess>();

  constructor(private readonly cfg: RunnerConfig) {}

  /** Nueva sesión. El id lo generamos nosotros para conocerlo antes del primer evento. */
  start(
    jobId: string,
    cwd: string,
    prompt: string,
    systemPrompt: string,
    onEvent: (ev: StreamEvent) => void,
    access: SessionAccess = {},
  ): RunHandle {
    const sessionId = randomUUID();
    const args = [...this.baseArgs(access), '--session-id', sessionId, '--append-system-prompt', systemPrompt];
    return this.spawnClaude(jobId, sessionId, cwd, args, prompt, onEvent);
  }

  /** Reanuda una sesión existente. `access` debe ser el mismo que en el arranque. */
  resume(
    jobId: string,
    cwd: string,
    sessionId: string,
    prompt: string,
    onEvent: (ev: StreamEvent) => void,
    access: SessionAccess = {},
  ): RunHandle {
    const args = [...this.baseArgs(access), '--resume', sessionId];
    return this.spawnClaude(jobId, sessionId, cwd, args, prompt, onEvent);
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  kill(jobId: string, reason: string): boolean {
    const child = this.running.get(jobId);
    if (!child) return false;
    logger().warn({ job: jobId, reason }, 'Matando proceso de Claude Code');
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    return true;
  }

  private baseArgs(access: SessionAccess): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', this.cfg.permissionMode];
    if (this.cfg.model) args.push('--model', this.cfg.model);
    // Solo las fuentes indicadas: así un .claude/settings.json del repo con reglas "ask"
    // (imposibles de contestar en headless) no bloquea Edit/Write.
    if (this.cfg.settingSources.length) args.push('--setting-sources', this.cfg.settingSources.join(','));

    // Directorios adicionales: otros worktrees (editables) y el repo de conocimiento / clones
    // de referencia (solo lectura: se deniega toda edición dentro de ellos).
    const addDirs = [...(access.writableDirs ?? []), ...(access.readOnlyDirs ?? [])];
    if (addDirs.length) args.push('--add-dir', ...addDirs);
    const deny = [...PROTECTED_READ_DENY];
    for (const dir of access.readOnlyDirs ?? []) {
      for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) deny.push(`${tool}(${dir.replace(/\/+$/, '')}/**)`);
    }
    args.push('--settings', JSON.stringify({ permissions: { deny } }));
    if (this.cfg.allowedTools.length) args.push('--allowedTools', ...this.cfg.allowedTools);
    if (this.cfg.disallowedTools.length) args.push('--disallowedTools', ...this.cfg.disallowedTools);
    return args;
  }

  private spawnClaude(
    jobId: string,
    sessionId: string,
    cwd: string,
    args: string[],
    prompt: string,
    onEvent: (ev: StreamEvent) => void,
  ): RunHandle {
    if (this.running.has(jobId)) throw new Error(`Ya hay un proceso de Claude Code para el job ${jobId}`);
    const log = logger().child({ job: jobId, session: sessionId, component: 'claude' });
    const started = Date.now();

    // El prompt va por stdin: evita límites de longitud de argumentos y problemas de escape.
    const child = spawn(this.cfg.bin, args, {
      cwd,
      env: {
        ...process.env,
        CI: 'true',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        // Ningún comando Bash puede pedir más de este tiempo. Un bucle "until" mirando un archivo
        // que no existía costó 10 minutos en un job real; con el tope, cuesta lo configurado.
        BASH_DEFAULT_TIMEOUT_MS: String(Math.min(120_000, this.cfg.bashTimeoutMs)),
        BASH_MAX_TIMEOUT_MS: String(this.cfg.bashTimeoutMs),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.running.set(jobId, child);
    log.info({ bin: this.cfg.bin, args: args.filter((a) => a !== prompt).join(' ').slice(0, 300) }, 'Claude Code lanzado');

    child.stdin.on('error', (err) => log.debug({ err: err.message }, 'stdin cerrado por el proceso'));
    child.stdin.end(prompt);

    let resultText = '';
    let isError = false;
    let errorReason: string | undefined;
    let numTurns: number | undefined;
    let costUsd: number | undefined;
    let sawResult = false;
    let timedOut = false;
    let killReason: string | undefined;
    let stderrTail = '';
    let closed = false;
    let resultGrace: NodeJS.Timeout | undefined;

    let lastActivity = Date.now();
    child.stderr.on('data', (d: Buffer) => {
      lastActivity = Date.now();
      stderrTail = (stderrTail + d.toString()).slice(-8000);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      lastActivity = Date.now();
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(trimmed) as StreamEvent;
      } catch {
        log.debug({ line: trimmed.slice(0, 200) }, 'Línea no JSON en stdout');
        return;
      }
      if (ev.type === 'result') {
        sawResult = true;
        // En -p el turno ha terminado. Si el proceso no sale (p. ej. dejó una tarea en segundo
        // plano o programó un ScheduleWakeup), lo cerramos con este resultado tras una gracia.
        if (!resultGrace) {
          resultGrace = setTimeout(() => {
            if (!closed) {
              log.warn('El proceso sigue vivo 20 s después del resultado; se cierra');
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000).unref();
            }
          }, 20_000);
          resultGrace.unref();
        }
        resultText = typeof ev.result === 'string' ? ev.result : '';
        isError = Boolean(ev.is_error);
        // Cuando falla la API (auth, cuota…), Claude Code pone el texto del error en `result`
        // y deja subtype "success"; el texto es lo útil.
        if (isError) errorReason = resultText.trim() || (ev.subtype && ev.subtype !== 'success' ? ev.subtype : 'error desconocido');
        numTurns = ev.num_turns;
        costUsd = ev.total_cost_usd;
      }
      try {
        onEvent(ev);
      } catch (err) {
        log.error({ err }, 'Error en el manejador de eventos');
      }
    });

    const kill = (reason: string) => {
      timedOut = true;
      killReason = reason;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    // Tope absoluto (JOB_TIMEOUT_MINUTES). Un bug difícil puede llevar legítimamente una hora de
    // trabajo real: el tope es red de seguridad, no medida de "demasiado lento".
    const timer = setTimeout(
      () => kill(this.cfg.timeoutMs >= 60_000 ? `tope de ${Math.round(this.cfg.timeoutMs / 60000)} min de sesión (JOB_TIMEOUT_MINUTES)` : `tope de ${Math.round(this.cfg.timeoutMs / 1000)} s`),
      this.cfg.timeoutMs,
    );
    // Colgado de verdad: ni una línea de salida en idleTimeoutMs. Un test largo en primer plano
    // no emite nada hasta terminar, por eso este umbral tiene que superar el tope de Bash.
    const idle = setInterval(() => {
      if (closed || Date.now() - lastActivity < this.cfg.idleTimeoutMs) return;
      kill(`sin actividad durante ${Math.round(this.cfg.idleTimeoutMs / 60000)} min (CLAUDE_IDLE_TIMEOUT_MINUTES)`);
    }, 15_000);
    idle.unref();

    const done = new Promise<RunOutcome>((resolve) => {
      let exitCode: number | null = null;
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearInterval(idle);
        if (resultGrace) clearTimeout(resultGrace);
        this.running.delete(jobId);
        const outcome: RunOutcome = {
          sessionId,
          resultText,
          isError: isError || !sawResult,
          errorReason: killReason ?? errorReason ?? (!sawResult ? `el proceso terminó (código ${exitCode}) sin emitir resultado` : undefined),
          timedOut,
          exitCode,
          durationMs: Date.now() - started,
          numTurns,
          costUsd,
          stderrTail: stderrTail.trim(),
        };
        log.info({ exitCode, turns: numTurns, costUsd, ms: outcome.durationMs, isError: outcome.isError }, 'Claude Code terminó');
        resolve(outcome);
      };
      child.on('error', (err) => {
        errorReason = `no se pudo ejecutar ${this.cfg.bin}: ${err.message}`;
        isError = true;
        finish();
      });
      child.on('close', (code) => {
        exitCode = code;
        // readline puede tener líneas pendientes; darle un tick.
        setImmediate(finish);
      });
    });

    return {
      sessionId,
      done,
      kill: (reason: string) => {
        killReason = reason;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      },
    };
  }
}

export function parseToolList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
