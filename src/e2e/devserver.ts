import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { logger } from '../logger.js';
import { run } from '../util/exec.js';

export interface DevServer {
  jobId: string;
  repoName: string;
  /** URL tal como la imprimió el propio proceso. Nunca se infiere. */
  url: string;
  port: number;
  pid: number;
}

export class EnvironmentError extends Error {
  constructor(
    message: string,
    /** Cola de la salida del proceso, para diagnóstico en el hilo. */
    readonly output: string | undefined,
    /** Datos del proceso ajeno que ocupa el puerto, si ese fue el problema. */
    readonly occupant?: { port: number; pid: number; command: string },
  ) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?\/?\S*/i;

/**
 * Levanta y vigila el servidor de desarrollo de un worktree.
 *
 * Reglas duras:
 * - La URL sale SOLO de la salida de nuestro proceso; jamás se sondea un puerto
 *   "por defecto". Probar contra un servidor ajeno mediría código sin el fix.
 * - Antes de dar el servidor por bueno se comprueba que quien escucha en ese
 *   puerto pertenece a nuestro árbol de procesos.
 * - Varios jobs del mismo repositorio pueden correr a la vez, cada uno con su
 *   servidor en su worktree: aunque el proyecto fije el puerto, los dev servers
 *   saltan al siguiente libre y la comprobación de propiedad hace el resto.
 */
export class DevServerManager {
  private readonly byJob = new Map<string, { server: DevServer; child: ChildProcess }>();

  constructor(private readonly timeoutMs: number) {}

  get(jobId: string): DevServer | undefined {
    return this.byJob.get(jobId)?.server;
  }

  /**
   * Arranca el comando en el worktree y espera a que imprima su URL. No espera a
   * que la app esté construida del todo: de eso se encarga el wrapper de pruebas.
   */
  async start(jobId: string, repoName: string, worktreePath: string, command: string): Promise<DevServer> {
    if (this.byJob.has(jobId)) this.stop(jobId); // reintento del mismo job: no dejar el anterior colgado

    const log = logger().child({ component: 'devserver', job: jobId, repo: repoName });
    const preferredPort = await freePort();
    const child = spawn(command, [], {
      cwd: worktreePath,
      shell: true,
      detached: true, // grupo propio: así podemos matar también a los hijos
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(preferredPort), BROWSER: 'none', NO_COLOR: '1', CI: 'true' },
    });
    log.info({ command, preferredPort, pid: child.pid }, 'Arrancando servidor de desarrollo');

    let tail = '';
    let url: string | undefined;
    const onData = (d: Buffer) => {
      const text = d.toString();
      tail = (tail + text).slice(-16_000);
      if (!url) {
        const m = URL_RE.exec(text);
        if (m) url = m[0].replace(/[),.'"]+$/, '');
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    let exited = false;
    child.on('exit', () => {
      exited = true;
    });

    const cleanup = () => killTree(child);

    const deadline = Date.now() + this.timeoutMs;
    while (!url && !exited && Date.now() < deadline) await sleep(500);

    if (exited) {
      cleanup();
      const hint = /EADDRINUSE|address already in use/i.test(tail) ? ' (el puerto ya estaba ocupado)' : '';
      throw new EnvironmentError(`el servidor de desarrollo terminó al arrancar${hint}`, lastLines(tail));
    }
    if (!url) {
      cleanup();
      throw new EnvironmentError(`el servidor de desarrollo no imprimió ninguna URL en ${Math.round(this.timeoutMs / 60000)} min`, lastLines(tail));
    }

    const port = Number(new URL(url).port || '80');
    const owner = await portOwner(port);
    if (owner && !(await isDescendant(owner.pid, child.pid ?? -1))) {
      cleanup();
      throw new EnvironmentError(
        `el puerto ${port} lo ocupa otro proceso (PID ${owner.pid}: ${owner.command}). No pruebo contra un servidor que no es el de este worktree.`,
        lastLines(tail),
        { port, pid: owner.pid, command: owner.command },
      );
    }

    const server: DevServer = { jobId, repoName, url: `http://localhost:${port}`, port, pid: child.pid ?? -1 };
    this.byJob.set(jobId, { server, child });
    child.on('exit', (code) => {
      log.warn({ code }, 'El servidor de desarrollo se detuvo');
      if (this.byJob.get(jobId)?.child === child) this.byJob.delete(jobId);
    });
    log.info({ url: server.url }, 'Servidor de desarrollo en marcha');
    return server;
  }

  stop(jobId: string): void {
    const entry = this.byJob.get(jobId);
    if (!entry) return;
    logger().info({ component: 'devserver', job: jobId, repo: entry.server.repoName }, 'Deteniendo servidor de desarrollo');
    killTree(entry.child);
    this.byJob.delete(jobId);
  }

  stopAll(): void {
    for (const jobId of [...this.byJob.keys()]) this.stop(jobId);
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // el grupo entero (detached)
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ya murió */
    }
  }
  setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* ya murió */
    }
  }, 5000).unref();
}

/** Quién escucha en un puerto, según lsof. undefined = nadie o no se pudo saber. */
async function portOwner(port: number): Promise<{ pid: number; command: string } | undefined> {
  try {
    const res = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc'], { cwd: process.cwd(), timeoutMs: 10_000 });
    let pid: number | undefined;
    let command = '';
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('c')) command = line.slice(1);
    }
    return pid ? { pid, command } : undefined;
  } catch {
    return undefined; // sin lsof no bloqueamos: la URL ya vino de nuestro proceso
  }
}

/** ¿`pid` es el propio `root` o uno de sus descendientes? */
async function isDescendant(pid: number, root: number): Promise<boolean> {
  if (pid === root) return true;
  if (root < 0) return false;
  try {
    const res = await run('ps', ['-eo', 'pid=,ppid='], { cwd: process.cwd(), timeoutMs: 10_000 });
    const parent = new Map<number, number>();
    for (const line of res.stdout.split('\n')) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (p && pp !== undefined) parent.set(p, pp);
    }
    let cur = pid;
    for (let i = 0; i < 30 && cur > 1; i++) {
      if (cur === root) return true;
      cur = parent.get(cur) ?? 0;
    }
    return false;
  } catch {
    return true; // sin ps, no podemos desmentirlo
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no se pudo reservar un puerto'))));
    });
    srv.on('error', reject);
  });
}

function lastLines(text: string, n = 20): string {
  return text.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
