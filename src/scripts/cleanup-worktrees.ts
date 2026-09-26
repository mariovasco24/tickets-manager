/**
 * Elimina del disco los worktrees de todos los jobs terminados (fixed, cannot_fix,
 * failed, discarded), en todos los repositorios implicados. Equivale al botón
 * "Limpiar worktrees cerrados" del dashboard, pero desde consola.
 *
 *   pnpm worktrees:cleanup            # elimina
 *   pnpm worktrees:cleanup --dry-run  # solo lista
 *
 * No toca Slack ni Jira. Puede ejecutarse con el servicio en marcha (SQLite en WAL).
 */
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { WorktreeManager } from '../git/worktree.js';
import { JobRepository } from '../jobs/repository.js';
import { JobService } from '../jobs/service.js';
import { initLogger } from '../logger.js';
import { resolveConfigPath } from '../util/paths.js';
import { projectRoot } from '../util/project-root.js';

const dryRun = process.argv.includes('--dry-run');
const config = loadConfig();
const log = initLogger('warn', true);

const db = openDatabase(config.DATABASE_PATH);
const jobs = new JobService(new JobRepository(db));
const worktrees = new WorktreeManager({
  remote: config.GIT_REMOTE,
  worktreesDir: resolveConfigPath(config.WORKTREES_DIR, projectRoot()),
  branchPrefix: config.BRANCH_PREFIX,
  installTimeoutMs: 0,
});

const candidates = jobs.listTerminalWithWorktree();
if (candidates.length === 0) {
  console.log('No hay worktrees de jobs terminados por limpiar.');
  process.exit(0);
}

let removed = 0;
let total = 0;
interface Target {
  repoName: string;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
  markRemoved: () => void;
}

for (const job of candidates) {
  const targets: Target[] = jobs.activeWorktrees(job.id).map((wt) => ({
    repoName: wt.repoName,
    repoPath: wt.repoPath,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    markRemoved: () => jobs.markWorktreeRemoved(job.id, wt, 'cli'),
  }));
  // Compatibilidad con jobs anteriores a job_worktrees (un solo repo, ruta en jobs.worktree_path).
  if (targets.length === 0 && job.worktreePath && !job.worktreeRemovedAt) {
    targets.push({
      repoName: '(legacy)',
      repoPath: path.dirname(job.worktreePath),
      worktreePath: job.worktreePath,
      branch: job.branch,
      markRemoved: () => jobs.worktreeRemoved(job.id, 'cli'),
    });
  }
  for (const wt of targets) {
    total++;
    const label = `${job.ticketKey} (${job.status}) ${wt.repoName} → ${wt.worktreePath}`;
    if (dryRun) {
      console.log(`[dry-run] ${label}`);
      continue;
    }
    try {
      await worktrees.remove(wt.repoPath, wt.worktreePath, wt.branch);
      wt.markRemoved();
      removed++;
      console.log(`eliminado  ${label}`);
    } catch (err) {
      log.error({ ticket: job.ticketKey, err: (err as Error).message }, 'No se pudo eliminar');
      console.log(`ERROR      ${label}: ${(err as Error).message}`);
    }
  }
}
if (!dryRun) console.log(`\n${removed}/${total} worktrees eliminados.`);
