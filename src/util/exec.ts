import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  /** Milisegundos; al vencer se mata el proceso (SIGKILL) y se rechaza. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Ejecutar vía shell (para INSTALL_COMMAND con pipes, &&, etc.). */
  shell?: boolean;
  /** Máximo de bytes de salida que se conservan (se guarda la cola). */
  maxOutput?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** true si se descartó parte de la salida por superar maxOutput (se conserva la cola). */
  truncated: boolean;
  /** stdout + stderr intercalados, recortados a la cola. */
  output: string;
  durationMs: number;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly result: RunResult | undefined,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'RunError';
  }
}

/**
 * Ejecuta un comando y devuelve su salida. Rechaza con RunError si el código de
 * salida no es 0 o si vence el timeout. Nunca hereda stdin.
 */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = opts.maxOutput ?? 64 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, CI: process.env.CI ?? 'true', NO_COLOR: '1' },
      shell: opts.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let combined = '';
    let timedOut = false;
    let truncated = false;

    const tail = (s: string, chunk: string) => {
      const next = s + chunk;
      if (next.length <= max) return next;
      truncated = true;
      return next.slice(next.length - max);
    };
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout = tail(stdout, s);
      combined = tail(combined, s);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr = tail(stderr, s);
      combined = tail(combined, s);
    });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new RunError(`No se pudo ejecutar ${cmd}: ${err.message}`, undefined));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = {
        code: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        truncated,
        output: combined.trim(),
        durationMs: Date.now() - started,
      };
      if (timedOut) {
        reject(new RunError(`${describe(cmd, args)} superó el timeout de ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`, result, true));
      } else if (result.code !== 0) {
        reject(new RunError(`${describe(cmd, args)} terminó con código ${result.code}`, result));
      } else {
        resolve(result);
      }
    });
  });
}

function describe(cmd: string, args: string[]): string {
  return [cmd, ...args].join(' ').slice(0, 120);
}

/** Últimas `lines` líneas de una salida, para pegarlas en Slack sin inundar el hilo. */
export function lastLines(output: string, lines = 15): string {
  const arr = output.split('\n').filter((l) => l.trim().length > 0);
  return arr.slice(-lines).join('\n');
}
