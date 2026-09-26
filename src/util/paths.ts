import os from 'node:os';
import path from 'node:path';

/**
 * Resuelve una ruta de configuración: expande `~` al home del usuario y la hace
 * absoluta respecto a `baseDir` si era relativa. Node no expande `~` por sí solo.
 */
export function resolveConfigPath(p: string, baseDir: string): string {
  const expanded = p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}
