#!/usr/bin/env bash
# import-secrets.sh — restaura en el PC NUEVO el paquete cifrado que creó export-secrets.sh.
# Guía completa: docs/nuevo-pc.md
#
#   scripts/migrate/import-secrets.sh ~/Downloads/tickets-manager-migracion-XXXX.tar.gz.enc
#   scripts/migrate/import-secrets.sh <paquete> --listar     # solo enseña qué trae, no toca nada
#
# Qué hace:
#   - Copia cada archivo a su sitio (repo/… dentro de este repo, home/… dentro de tu $HOME).
#   - Si un archivo ya existe y es distinto, guarda el actual como <archivo>.antes-de-migrar-<fecha>.
#   - Si tu $HOME o la ruta del repo cambian respecto al PC viejo, corrige las rutas del LaunchAgent
#     del túnel y renombra las carpetas de sesiones de Claude para que `claude --resume` las encuentre.
#   - Pone permisos 600/700 en ~/.ssh.
# Qué NO hace: arrancar el túnel ni el servidor (la guía dice cuándo; antes hay que apagar el PC viejo).
#
# Contraseña: se pide por teclado. Para automatizar, TM_BUNDLE_PASS en el entorno.
# Para pruebas: TM_IMPORT_HOME sustituye a $HOME como destino de home/….
set -euo pipefail

BUNDLE=${1:?Uso: import-secrets.sh <paquete.tar.gz.enc> [--listar]}
MODE=${2:-}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DEST_HOME=${TM_IMPORT_HOME:-$HOME}
STAMP=$(date +%Y%m%d-%H%M%S)

STAGE=$(mktemp -d)
chmod 700 "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

PASS_ARGS=()
[ -n "${TM_BUNDLE_PASS:-}" ] && PASS_ARGS=(-pass env:TM_BUNDLE_PASS)
openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 600000 ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} -in "$BUNDLE" |
  tar -xzf - -C "$STAGE" || { echo "No se pudo descifrar: ¿contraseña correcta?" >&2; exit 1; }

OLD_HOME=$(sed -n 's/^OLD_HOME=//p' "$STAGE/MANIFEST.txt")
OLD_REPO=$(sed -n 's/^OLD_REPO=//p' "$STAGE/MANIFEST.txt")
sed '/^\[archivos\]/q' "$STAGE/MANIFEST.txt"
if [ "$MODE" = "--listar" ]; then
  sed -n '/^\[archivos\]/,$p' "$STAGE/MANIFEST.txt"
  exit 0
fi

# Codificación de rutas que usa Claude Code para ~/.claude/projects (todo lo no alfanumérico → "-").
enc() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

place() { # place <origen en el paquete> <destino>
  local src=$1 dest=$2
  if [ -e "$dest" ] && ! diff -rq "$src" "$dest" >/dev/null 2>&1; then
    mv "$dest" "$dest.antes-de-migrar-$STAMP"
    echo "  ~ $dest (el anterior quedó en .antes-de-migrar-$STAMP)"
  elif [ -e "$dest" ]; then
    echo "  = $dest (idéntico, sin cambios)"
    return
  else
    echo "  + $dest"
  fi
  mkdir -p "$(dirname "$dest")"
  cp -Rp "$src" "$dest"
}

echo
echo "Proyecto → $REPO"
if [ -d "$STAGE/repo" ]; then
  (cd "$STAGE/repo" && find . -type f -not -path './data/artifacts/*' | sed 's|^\./||') | while read -r f; do
    place "$STAGE/repo/$f" "$REPO/$f"
  done
  [ -d "$STAGE/repo/data/artifacts" ] && place "$STAGE/repo/data/artifacts" "$REPO/data/artifacts"
fi

echo
echo "Home → $DEST_HOME"
# Sesiones de Claude: carpeta renombrada si cambian $HOME o la ruta del repo.
if [ -d "$STAGE/home/.claude/projects" ]; then
  for d in "$STAGE"/home/.claude/projects/*; do
    name=$(basename "$d")
    new=$name
    case "$name" in
      "$(enc "$OLD_REPO")") new=$(enc "$REPO") ;;
      "$(enc "$OLD_HOME")"*) new="$(enc "$DEST_HOME")${name#"$(enc "$OLD_HOME")"}" ;;
    esac
    [ "$new" != "$name" ] && echo "  · sesiones $name → $new"
    place "$d" "$DEST_HOME/.claude/projects/$new"
  done
  rm -rf "$STAGE/home/.claude/projects"
fi
(cd "$STAGE/home" && find . -type f | sed 's|^\./||') | while read -r f; do
  place "$STAGE/home/$f" "$DEST_HOME/$f"
done

# Rutas absolutas del PC viejo dentro del LaunchAgent del túnel.
PLIST="$DEST_HOME/Library/LaunchAgents/me.mariovasco.bugs-manager-tunnel.plist"
if [ -f "$PLIST" ] && [ "$OLD_HOME" != "$DEST_HOME" ]; then
  sed -i '' "s|$OLD_HOME/|$DEST_HOME/|g" "$PLIST"
  echo "  · rutas del LaunchAgent cambiadas de $OLD_HOME a $DEST_HOME"
fi

if [ -d "$DEST_HOME/.ssh" ]; then
  chmod 700 "$DEST_HOME/.ssh"
  for k in id_ed25519 bugs_tunnel_ed25519 config; do
    [ -f "$DEST_HOME/.ssh/$k" ] && chmod 600 "$DEST_HOME/.ssh/$k"
  done
fi

echo
echo "Restaurado. Siguiente paso: docs/nuevo-pc.md, sección «Después de importar»."
