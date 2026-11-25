# API externa: pedir el fix de un ticket (contrato v1)

Sirve para que un agente externo (por ejemplo, el agente del equipo de QA), cuando concluye que un bug
lo tiene que resolver desarrollo, lance el mismo flujo que `/fix AN-1234` en Slack.

La petición **solo arranca el flujo**. Todas las confirmaciones humanas se mantienen en el hilo de Slack:
estado en Jira, rama origen, repositorios, PR y comentario en el ticket. El agente externo no puede
escribir en Jira, abrir PRs ni contestar preguntas.

## Autenticación

Cada agente tiene su propio token (`EXTERNAL_API_TOKENS=nombre:token`). Se envía en todas las peticiones:

```
Authorization: Bearer <token>
```

El nombre asociado al token aparece en Slack como quien pidió el fix. Para revocar un agente, quita su
entrada y reinicia el servicio.

## POST /external/v1/fix-requests

Cuerpo JSON (no se admiten campos extra):

| Campo           | Tipo   | Obligatorio | Descripción |
|-----------------|--------|-------------|-------------|
| `ticket`        | string | sí          | Clave del ticket de Jira, `PROYECTO-123` (también acepta minúsculas). |
| `requested_by`  | string | no          | Persona en cuyo nombre pide el agente (máx. 100). Se muestra en Slack. |
| `reason`        | string | no          | Por qué lo debe resolver desarrollo: análisis, pasos, evidencia (máx. 4000). Llega a Claude Code como notas del equipo. |
| `source_branch` | string | no          | Rama origen (p. ej. `dev/release.9.6`). Si falta o no existe, se pregunta en Slack. |

```bash
curl -X POST https://<host>/external/v1/fix-requests \
  -H "Authorization: Bearer $BUGS_MANAGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ticket":"AN-28863","requested_by":"QA Team","reason":"Reproduced on dev: the date picker is unreadable with a dark theme.","source_branch":"dev/release.9.6"}'
```

Respuestas:

| Código | Significado |
|--------|-------------|
| `202`  | Job creado (`"created": true`). |
| `200`  | Ya había un job activo para ese ticket; se devuelve ese (`"created": false`). Es seguro reintentar. |
| `400`  | `invalid_request`: el cuerpo no cumple el contrato (`error.details` dice qué). |
| `401`  | `unauthorized`: falta el token o no es válido. |
| `409`  | `ticket_closed`: el ticket está cerrado en Jira; no se hace nada. |
| `422`  | `project_not_allowed` o `ticket_unreadable` (no existe o no se pudo leer en Jira). |
| `429`  | `rate_limited`: demasiadas peticiones de este agente en la última hora (`Retry-After`). |

Los errores siempre tienen la forma `{"error":{"code":"...","message":"...","details":[...]}}`.

Cuerpo de éxito (también lo devuelve el GET de abajo):

```json
{
  "created": true,
  "job_id": "5cdab3ce-0640-4a23-b8b3-987e25902537",
  "ticket": "AN-28863",
  "ticket_url": "https://<site>.atlassian.net/browse/AN-28863",
  "status": "awaiting_jira_status",
  "status_label": "Estado en Jira",
  "state": "waiting_for_human",
  "pending_question": "¿Muevo AN-28863 en Jira de \"Open\" a \"In Progress\"?",
  "requested_by": "QA Team (vía qa-agent)",
  "source_branch": "dev/release.9.6",
  "slack_thread_url": "https://<workspace>.slack.com/archives/...",
  "dashboard_url": "https://<host>/?job=5cdab3ce-...",
  "result": null,
  "created_at": "2026-10-09T15:00:00.000Z",
  "updated_at": "2026-10-09T15:00:02.000Z",
  "finished_at": null
}
```

## GET /external/v1/fix-requests/{job_id}

Estado de una petición hecha por esta API (para hacer seguimiento con polling; con uno cada pocos minutos basta).

- `state`: `in_progress` | `waiting_for_human` | `finished`.
- `status`: el estado interno (`triaging`, `working`, `awaiting_clarification`, `fixed`, `cannot_fix`, `failed`, `discarded`, …).
- `result`, cuando termina:
  - `{"kind":"fixed" | "already_fixed", "already_fixed_by", "issue", "solution", "notes_for_qa", "reproduction"}`
  - `{"kind":"cannot_fix" | "failed" | "discarded", "reason"}`

No se exponen rutas locales, costes ni la transcripción de la sesión.

## Exponerlo a internet: bugs-hub (montaje actual)

QA no llama directamente a ningún bugs-manager. Llama a **bugs-hub** (`hub/bugs-hub.mjs`), que corre en el
VPS. El hub lee `assignee_email` y entrega la petición a ese desarrollador según su modo:

- `inbox`: el dev consulta `GET /external/v1/inbox` con su token personal, o se queda conectado a `GET /external/v1/stream`.
  El stream es Server-Sent Events: al conectar envía los pendientes y después cada aviso en vivo (`event: fix_requested`), con un latido cada 25 s.
  Cliente listo en `hub/clients/bugs-listen.sh`.
- `webhook`: el hub hace `POST` del evento `fix_requested`, firmado con `X-Bugs-Hub-Signature-256` (HMAC-SHA256 con el token del dev), con reintentos durante unas 28 horas. El aviso sigue disponible en la bandeja.
- `bugs-manager`: el hub reenvía la petición a su bugs-manager por túnel, como en el caso de Mario.

En los modos `inbox` y `webhook` el estado lo guarda el hub (`/var/lib/bugs-hub/requests.json`) y el dev lo actualiza con `POST /external/v1/fix-requests/{id}/status`. QA lo consulta con el mismo `GET` de siempre. La guía para QA
y para los desarrolladores está en el artefacto "Bugs Manager QA API".

```
Agente QA ──HTTPS──▶ Nginx (sitio "bugs-manager", solo /external/*) ──▶ bugs-hub 127.0.0.1:9070
                        └─ assignee_email ─▶ 127.0.0.1:<puerto del dev> ──túnel SSH inverso──▶ bugs-manager del dev
```

- **URL pública:** `https://89-117-56-211.sslip.io/external/v1`.
- **Rutas del hub:**
  - `GET /assignees`
  - `POST /fix-requests`: igual que el contrato de arriba, más `assignee_email` como campo obligatorio.
  - `GET /fix-requests/{job_id}`: el hub recuerda el dev de cada job.
- **Errores propios del hub:**
  - `422 assignee_not_registered`
  - `502 assignee_unavailable` (dev desconectado)
  - `502 assignee_misconfigured` (token del dev no coincide)
- **Tokens:**
  - El agente de QA se autentica contra el hub (`/var/lib/bugs-hub/clients.json`).
  - El hub se autentica contra cada bugs-manager con un token por dev. Es la línea `EXTERNAL_API_TOKENS=qa-hub:<token>` del `.env` de cada dev.
- **VPS** (todo nuevo, sin tocar los demás proyectos):
  - `/opt/bugs-hub/bugs-hub.mjs` y el servicio systemd `bugs-hub`.
  - Datos en `/var/lib/bugs-hub`.
  - Sitio Nginx `bugs-manager` con certificado Let's Encrypt (webroot `/var/lib/bugs-manager-acme`).
  - Una línea restringida (`permitlisten` + `nologin`) en `/root/.ssh/authorized_keys` por cada túnel.
- **Mac de Mario:**
  - Agente de `launchd` `me.mariovasco.bugs-manager-tunnel` (puerto 9077, clave `~/.ssh/bugs_tunnel_ed25519`).
  - Log en `~/Library/Logs/bugs-manager-tunnel.log`.

Administración (en el VPS; los cambios surten efecto sin reiniciar):

```bash
HUB="/root/.nvm/versions/node/v24.11.1/bin/node /opt/bugs-hub/bugs-hub.mjs"
$HUB list
$HUB add-dev --email ana@qrvey.com --name "Ana" --pubkey "ssh-ed25519 AAAA…"   # asigna puerto y token
$HUB add-dev --email ana@qrvey.com --name "Ana" --upstream https://ana.example.com
$HUB remove-dev --email ana@qrvey.com
systemctl status bugs-hub; journalctl -u bugs-hub -n 50
```

Para desplegar una versión nueva del hub: `scp hub/bugs-hub.mjs root@89.117.56.211:/opt/bugs-hub/ && ssh root@89.117.56.211 systemctl restart bugs-hub`.
