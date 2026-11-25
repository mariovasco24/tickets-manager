#!/usr/bin/env bash
# export-secrets.sh — empaqueta y CIFRA todo lo que tickets-manager necesita y que no está en git
# (.env, llaves SSH, túnel al VPS, base de datos, sesiones y memoria de Claude…), para llevarlo a otro PC.
# Se ejecuta en el PC VIEJO. El paquete se restaura con import-secrets.sh. Guía: docs/nuevo-pc.md
#
#   scripts/migrate/export-secrets.sh                      # pide contraseña; deja el paquete en el Escritorio
#   scripts/migrate/export-secrets.sh --con-artefactos     # incluye data/artifacts (vídeos de Playwright, GB)
#   scripts/migrate/export-secrets.sh --sin-sesiones       # no incluye las sesiones de Claude Code
#   scripts/migrate/export-secrets.sh --salida /ruta/paquete.tar.gz.enc
#
# Contraseña: se pide por teclado. Para automatizar, TM_BUNDLE_PASS en el entorno.
# El paquete NUNCA va al repo (lleva tokens y llaves privadas). Llévalo en un USB o en tu gestor de
# contraseñas, y la contraseña por otro lado.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$HOME/Desktop/tickets-manager-migracion-$(date +%Y%m%d-%H%M).tar.gz.enc"
WITH_ARTIFACTS=0
WITH_SESSIONS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --con-artefactos) WITH_ARTIFACTS=1 ;;
    --sin-sesiones) WITH_SESSIONS=0 ;;
    --salida) OUT=$2; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
  shift
done

STAGE=$(mktemp -d)
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
MANIFEST="$STAGE/MANIFEST.txt"

# add <origen> <destino dentro del paquete: repo/… o home/…>
add() {
  local src=$1 dest=$2
  if [ -e "$src" ]; then
    mkdir -p "$STAGE/$(dirname "$dest")"
    cp -Rp "$src" "$STAGE/$dest"
    echo "  + $dest"
    echo "$dest" >>"$MANIFEST.files"
  else
    echo "  - $dest (no existe aquí, se omite)"
  fi
}

echo "Empaquetando desde $REPO"
{
  echo "OLD_HOME=$HOME"
  echo "OLD_REPO=$REPO"
  echo "CREATED=$(date '+%Y-%m-%d %H:%M:%S')"
  echo "HOST=$(hostname)"
  echo "NODE=$(node -v 2>/dev/null || echo '?')"
  echo "PNPM=$(pnpm -v 2>/dev/null || echo '?')"
  echo "CLAUDE=$(claude --version 2>/dev/null || echo '?')"
  echo "GIT_COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')"
} >"$MANIFEST"

# --- Proyecto --------------------------------------------------------------------------------
add "$REPO/.env" repo/.env
add "$REPO/environments.json" repo/environments.json
add "$REPO/.claude/settings.local.json" repo/.claude/settings.local.json

# Base de datos: copia consistente aunque el servidor esté corriendo (WAL incluido).
if [ -f "$REPO/data/bugs-manager.db" ]; then
  mkdir -p "$STAGE/repo/data"
  sqlite3 "$REPO/data/bugs-manager.db" ".backup '$STAGE/repo/data/bugs-manager.db'"
  echo "  + repo/data/bugs-manager.db (backup consistente)"
  echo "repo/data/bugs-manager.db" >>"$MANIFEST.files"
fi
if [ "$WITH_ARTIFACTS" = 1 ]; then
  add "$REPO/data/artifacts" repo/data/artifacts
else
  echo "  · repo/data/artifacts no incluido (usa --con-artefactos si quieres los vídeos y trazas)"
fi

# --- Llaves SSH y túnel ----------------------------------------------------------------------
# id_ed25519: Bitbucket (qrvey_platform_knowledge y repos de producto).
# bugs_tunnel_ed25519: túnel inverso al VPS (89.117.56.211), lo usa el LaunchAgent.
add "$HOME/.ssh/id_ed25519" home/.ssh/id_ed25519
add "$HOME/.ssh/id_ed25519.pub" home/.ssh/id_ed25519.pub
add "$HOME/.ssh/bugs_tunnel_ed25519" home/.ssh/bugs_tunnel_ed25519
add "$HOME/.ssh/bugs_tunnel_ed25519.pub" home/.ssh/bugs_tunnel_ed25519.pub
add "$HOME/.ssh/config" home/.ssh/config
add "$HOME/.ssh/known_hosts" home/.ssh/known_hosts
add "$HOME/Library/LaunchAgents/me.mariovasco.bugs-manager-tunnel.plist" \
    home/Library/LaunchAgents/me.mariovasco.bugs-manager-tunnel.plist

# --- Archivos que se copian a los worktrees (COPY_FILES / REPO_*_COPY_FILES del .env) ----------
add "$HOME/analytiq_widget/.env" home/analytiq_widget/.env

# --- Claude Code: ajustes de usuario, sesiones y memoria -------------------------------------
add "$HOME/.claude/settings.json" home/.claude/settings.json
if [ "$WITH_SESSIONS" = 1 ]; then
  for d in "$HOME"/.claude/projects/*; do
    case "$(basename "$d")" in
      *tickets-manager*|*Bugs-Manager*|*qrvey-platform-knowledge*)
        add "$d" "home/.claude/projects/$(basename "$d")" ;;
    esac
  done
else
  echo "  · sesiones de Claude no incluidas (--sin-sesiones)"
fi

sort -o "$MANIFEST.files" "$MANIFEST.files"
{ echo; echo "[archivos]"; cat "$MANIFEST.files"; } >>"$MANIFEST"
rm "$MANIFEST.files"

echo
echo "Cifrando (AES-256, contraseña con PBKDF2)…"
mkdir -p "$(dirname "$OUT")"
PASS_ARGS=()
[ -n "${TM_BUNDLE_PASS:-}" ] && PASS_ARGS=(-pass env:TM_BUNDLE_PASS)
tar -czf - -C "$STAGE" . |
  openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 600000 -salt ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -out "$OUT"
chmod 600 "$OUT"

echo
echo "Listo: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Llévalo en un USB o súbelo a tu gestor de contraseñas. NO lo subas a git ni a un chat."
echo "En el PC nuevo: scripts/migrate/import-secrets.sh \"<ruta del paquete>\""
