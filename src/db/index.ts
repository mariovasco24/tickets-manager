import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { resolveConfigPath } from '../util/paths.js';
import { projectRoot } from '../util/project-root.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Abre (o crea) la base SQLite y aplica las migraciones de ./drizzle al arrancar,
 * así un job en awaiting_* sobrevive a un reinicio sin pasos manuales.
 */
export function openDatabase(databasePath: string): Db {
  const resolved = resolveConfigPath(databasePath, projectRoot());
  mkdirSync(path.dirname(resolved), { recursive: true });

  const sqlite = new Database(resolved);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(projectRoot(), 'drizzle') });
  logger().info({ path: resolved }, 'SQLite abierta y migrada');
  return db;
}
