#!/usr/bin/env node
/**
 * Banco de pruebas: crea un entorno completo y falso (repo de conocimiento,
 * remotos git, repos de producto) para ejercitar el servicio sin tocar Jira,
 * Slack ni Claude de verdad. Vive en el repo porque el directorio temporal del
 * sistema se borra entre sesiones.
 *
 *   node scripts/dev/rig.mjs <dir>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

/** Repo de producto falso: una app con interfaz y un bug visible en una página. */
function productRepo(dir, { frontend }) {
  mkdirSync(path.join(dir, 'src', 'html_pages'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: path.basename(dir),
        version: '1.0.0',
        scripts: frontend ? { start: 'node server.mjs', test: 'node test.mjs' } : { test: 'node test.mjs' },
        dependencies: frontend ? { vite: '^5.0.0' } : { express: '^4.0.0' },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(dir, 'test.mjs'), 'console.log("unit tests ok");\n');

  if (!frontend) return;

  // El bug: la etiqueta por defecto repite una existente. El "fix" la corrige.
  writeFileSync(path.join(dir, 'src', 'labels.js'), "export const nextLabel = () => 'Threshold 2'; // BUG: duplica\n");
  writeFileSync(
    path.join(dir, 'src', 'html_pages', 'bug.html'),
    `<!doctype html><html><body>
  <ul id="list"><li>Threshold 2</li></ul>
  <div id="new"></div>
  <script type="module">
    import { nextLabel } from '../labels.js';
    document.getElementById('new').textContent = nextLabel();
  </script>
</body></html>
`,
  );
  // www/ es salida de build, como en Stencil: fuera del control de versiones.
  writeFileSync(path.join(dir, '.gitignore'), 'www/\nnode_modules/\n');
  // Servidor estático que imprime su URL, como haría Stencil o Vite.
  writeFileSync(
    path.join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const fixed = process.env.RIG_FIXED_PORT ? Number(process.env.RIG_FIXED_PORT) : undefined;
const lie = process.env.RIG_LIE_PORT ? Number(process.env.RIG_LIE_PORT) : undefined;
// RIG_BUILD_DELAY_MS imita a Stencil: se sirve una copia en www/ que se "reconstruye" (copiando
// src/) unos segundos después de cada cambio. Sin ella, se sirve src/ directamente, como Vite.
const delay = process.env.RIG_BUILD_DELAY_MS ? Number(process.env.RIG_BUILD_DELAY_MS) : undefined;
if (process.env.RIG_NEVER_STARTS) { console.error('boom: no puedo arrancar'); process.exit(1); }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const bases = delay === undefined ? ['src/html_pages', 'src', '.'] : ['www'];
const newest = (dir) => {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    m = Math.max(m, e.isDirectory() ? newest(f) : statSync(f).mtimeMs);
  }
  return m;
};
const build = () => {
  cpSync(path.join(root, 'src'), path.join(root, 'www'), { recursive: true });
  mkdirSync(path.join(root, 'www', 'build'), { recursive: true });
  writeFileSync(path.join(root, 'www', 'build', 'app.esm.js'), '// bundle (rig) ' + Date.now() + '\\n');
};
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? '/html_pages/bug.html' : url.pathname;
  for (const base of bases) {
    const file = path.join(root, base, rel.replace(/^\\/(src\\/html_pages|src)?/, ''));
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'text/plain' });
      res.end(readFileSync(file));
      return;
    }
  }
  res.writeHead(404); res.end('not found');
});
if (delay !== undefined) {
  build();
  let built = newest(path.join(root, 'src'));
  setInterval(() => {
    const m = newest(path.join(root, 'src'));
    if (m > built) { built = m; setTimeout(build, delay); }
  }, 300);
}
server.listen(fixed ?? Number(process.env.PORT ?? 0), () => {
  const real = server.address().port;
  // RIG_LIE_PORT simula un dev server que anuncia un puerto que no es suyo.
  console.log('  build finished, dev server running at http://localhost:' + (lie ?? real) + '/');
});
`,
  );
}

export function buildRig(root) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const kb = path.join(root, 'knowledge');
  mkdirSync(path.join(kb, 'config'), { recursive: true });
  mkdirSync(path.join(kb, 'scripts'), { recursive: true });
  mkdirSync(path.join(kb, 'repos_product'), { recursive: true });
  mkdirSync(path.join(kb, 'docs', 'catalog', 'repositories'), { recursive: true });
  mkdirSync(path.join(kb, 'plans'), { recursive: true });
  writeFileSync(path.join(kb, 'AGENTS.md'), '# repo de conocimiento (rig)\n');
  writeFileSync(path.join(kb, 'docs', 'catalog', 'retrieval-index.md'), '# retrieval index (rig)\n');
  writeFileSync(path.join(kb, 'config', 'repos_product.manifest'), '# rig\nwidget_front\nservice_back\n');
  writeFileSync(
    path.join(kb, 'scripts', 'setup.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
MANIFEST="config/repos_product.manifest"
while [[ $# -gt 0 ]]; do case "$1" in --manifest) MANIFEST="$2"; shift 2;; *) shift;; esac; done
grep -vE '^[[:space:]]*(#|$)' "$MANIFEST" | while read -r name _; do
  [[ -d "repos_product/$name/.git" ]] && continue
  git clone -q "${root}/remotes/$name.git" "repos_product/$name"
done
`,
  );
  chmodSync(path.join(kb, 'scripts', 'setup.sh'), 0o755);

  // Remotos y clones: widget_front (con interfaz) y service_back (sin interfaz).
  mkdirSync(path.join(root, 'remotes'), { recursive: true });
  for (const [name, frontend] of [
    ['widget_front', true],
    ['service_back', false],
  ]) {
    const remote = path.join(root, 'remotes', `${name}.git`);
    const seed = path.join(root, 'seed', name);
    git(root, 'init', '-q', '--bare', remote);
    mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q');
    productRepo(seed, { frontend });
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.email=rig@test', '-c', 'user.name=rig', 'commit', '-qm', 'init');
    git(seed, 'branch', '-M', 'develop');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', 'origin', 'develop');
    // widget_front se deja clonado; service_back se clonará bajo demanda.
    if (frontend) git(root, 'clone', '-q', remote, path.join(kb, 'repos_product', name));
  }

  return { knowledge: kb, worktrees: path.join(root, 'worktrees'), artifacts: path.join(root, 'artifacts') };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const target = process.argv[2] ?? path.join(process.cwd(), '.rig');
  const r = buildRig(path.resolve(target));
  console.log(JSON.stringify(r, null, 2));
}
