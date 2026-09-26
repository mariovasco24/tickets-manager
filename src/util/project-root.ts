import { existsSync } from 'node:fs';
import path from 'node:path';

let cached: string | undefined;

/**
 * Raíz del proyecto (el directorio con package.json), válida tanto ejecutando
 * desde src/ con tsx como desde dist/ compilado. Evita depender de process.cwd().
 */
export function projectRoot(): string {
  if (cached) return cached;
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'package.json'))) {
      cached = dir;
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('No se encontró package.json subiendo desde ' + import.meta.dirname);
}
