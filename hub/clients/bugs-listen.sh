#!/usr/bin/env bash
# bugs-listen.sh — se queda conectado a bugs-hub (Server-Sent Events) y avisa al instante de cada bug
# que QA te asigna. Al conectar recibe también los pendientes. Se reconecta solo.
#
#   export DEV_TOKEN="<tu token personal>"
#   ./bugs-listen.sh
#
# Requiere curl y jq. Para avisar por otro canal (Slack, Teams, tu gestor de tareas…), define
# BUGS_NOTIFY_CMD con un comando que reciba dos argumentos: título y mensaje.
set -u
BASE="${BUGS_HUB_URL:-https://89-117-56-211.sslip.io/external/v1}"
: "${DEV_TOKEN:?Define DEV_TOKEN con tu token personal}"
command -v jq >/dev/null || { echo "Falta jq (brew install jq / apt install jq)" >&2; exit 1; }

# Token válido antes de entrar en el bucle (un 401 no se arregla reintentando).
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/inbox" -H "Authorization: Bearer $DEV_TOKEN")
if [ "$code" = 401 ]; then echo "Token rechazado (401). Revisa DEV_TOKEN." >&2; exit 1; fi

notify() {
  if [ -n "${BUGS_NOTIFY_CMD:-}" ]; then "$BUGS_NOTIFY_CMD" "$1" "$2"
  elif command -v osascript >/dev/null; then osascript -e "display notification \"${2//\"/\'}\" with title \"${1//\"/\'}\" sound name \"Glass\""
  elif command -v notify-send >/dev/null; then notify-send -u critical "$1" "$2"
  fi
  echo "[$(date '+%H:%M:%S')] $1: $2"
}

handle() {
  local json="$1" id ticket who url
  id=$(jq -r .id <<<"$json")
  ticket=$(jq -r .ticket <<<"$json")
  who=$(jq -r .requested_by <<<"$json")
  url=$(jq -r .ticket_url <<<"$json")
  notify "Bug asignado: $ticket" "$who te pide resolverlo. $url"
  # Marcar como recibido: deja de reenviarse al reconectar y QA lo ve.
  curl -s -o /dev/null -X POST "$BASE/fix-requests/$id/status" \
    -H "Authorization: Bearer $DEV_TOKEN" -H "Content-Type: application/json" \
    -d '{"status":"acknowledged"}'
}

while true; do
  curl -sN --fail "$BASE/stream" -H "Authorization: Bearer $DEV_TOKEN" | {
    event=""
    while IFS= read -r line; do
      line="${line%$'\r'}"
      case "$line" in
        event:*) event="${line#event: }" ;;
        data:*)
          data="${line#data: }"
          if [ "$event" = fix_requested ]; then handle "$data"
          elif [ "$event" = ready ]; then echo "[$(date '+%H:%M:%S')] Conectado como $(jq -r .email <<<"$data"). Esperando bugs…"; fi ;;
        "") event="" ;;
      esac
    done
  }
  echo "[$(date '+%H:%M:%S')] Conexión cerrada; reintento en 5 s" >&2
  sleep 5
done
