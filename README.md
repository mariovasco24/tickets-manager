# Bugs Manager

Orquestador **Jira → Slack → Claude Code**. Toma un bug de Jira (por webhook o a petición desde
Slack), abre un hilo en un canal privado, hace un **triaje sobre el catálogo de la plataforma**
(`qrvey_platform_knowledge`) para decidir en qué repositorio(s) está la causa, crea un worktree
por repositorio en la misma rama, lanza Claude Code en modo headless con acceso a todos ellos y
coordina contigo las dudas por el hilo. Nunca hace merge ni commit por su cuenta. En Jira solo lee,
salvo un único cambio que **siempre te pregunta antes**: mover el ticket a "In Progress" al empezar.

Estado actual: **fase 5** + reproducción verificada en navegador. Ver [plan de fases](#plan-de-fases).

## Requisitos

- Node ≥ 22 (probado con 24) y `pnpm`
- Cuenta de Jira Cloud con permiso para leer el proyecto y (para el webhook) permisos de administrador de Jira
- Permiso para crear apps en tu workspace de Slack
- `cloudflared` para exponer el puerto local (solo mientras corra en tu máquina)

## Puesta en marcha

### Primera instalación

1. **Node ≥ 22.** Comprueba con `node -v`. Si usas nvm: `nvm install 24 && nvm use 24`.

2. **pnpm.** Si `pnpm -v` dice `command not found`, actívalo con corepack (viene con Node):

   ```bash
   corepack enable pnpm
   ```

   `package.json` fija la versión (`packageManager`), así que corepack usa la misma que el resto
   del equipo. Con nvm, pnpm queda ligado a esa versión de Node: si cambias de versión, repite
   el comando. Usa siempre pnpm, no `npm install` (generaría un `package-lock.json` que sobra).

3. **Instalar dependencias:**

   ```bash
   pnpm install
   ```

   Si falla con `ERR_PNPM_IGNORED_BUILDS`, es que falta o se estropeó `pnpm-workspace.yaml`, que
   viene en el repo. Desde pnpm 10, los paquetes que compilan binarios al instalarse
   (`better-sqlite3` y `esbuild`) tienen que aprobarse ahí. Si ese archivo contiene
   `set this to true or false`, cambia su contenido por este y vuelve a ejecutar `pnpm install`:

   ```yaml
   allowBuilds:
     better-sqlite3: true
     esbuild: true
   ```

4. **Configurar el entorno.** Copia `.env.example` a `.env` y rellénalo siguiendo la
   [guía de credenciales](#guía-de-credenciales-paso-a-paso). Como mínimo, Jira (paso 1) y
   Slack (paso 3). Revisa también `KNOWLEDGE_REPO_PATH` (el catálogo `qrvey_platform_knowledge`)
   y `WORKTREES_DIR`.

   ```bash
   cp .env.example .env
   ```

5. **Opcional: ambientes de datos para reproducir en navegador.** Sin este archivo el servidor
   arranca igual, pero avisa de que E2E no tiene ambiente, y los jobs de frontend te preguntarán
   en el hilo. Ver [Reproducción en navegador](#reproducción-en-navegador-playwright).

   ```bash
   cp environments.example.json environments.json
   ```

6. **Compilar el dashboard.** Genera `dist/web`, que Express sirve en `/`. Repítelo cuando
   cambie el frontend.

   ```bash
   pnpm build:web
   ```

7. **Arrancar el servidor** con recarga en caliente:

   ```bash
   pnpm dev
   ```

### Cómo saber que arrancó bien

El arranque está listo cuando aparece `HTTP escuchando en http://localhost:3000`. La primera vez
puede tardar unos segundos más. Después deberían salir estas líneas:

- `Jira: credenciales OK`
- `Slack: bot token OK`
- `Slack: el bot es miembro del canal`
- `Slack Socket Mode conectado`

Los fallos de credenciales avisan pero no detienen el servidor, así puedes probar un lado sin
tener el otro. Estos avisos también son normales mientras no configures lo correspondiente:

- **`E2E activado pero el ambiente de datos elegido no está disponible`:** falta
  `environments.json` (paso 5).
- **`Webhook de Jira: https://xxxx-xxxx.trycloudflare.com/...`:** `PUBLIC_BASE_URL` sigue con el
  valor de ejemplo. Solo importa si usas el webhook o Slack en modo HTTP (ver el paso 5 de la
  guía, el del túnel).

Si el log se queda parado antes de `HTTP escuchando` y no sale ningún error, puede que
`tsx watch` haya perdido el proceso. Para verlo, corta con Ctrl+C y ejecuta
`pnpm exec tsx src/index.ts`, que muestra el error real.

El dashboard queda en <http://localhost:3000>. Si vas a tocar el frontend, en otra terminal
`pnpm dev:web` levanta Vite en <http://localhost:5173> con recarga en caliente y proxy de
`/api` al servidor; en ese caso no hace falta `build:web` hasta que termines.

La base SQLite se crea sola en `DATABASE_PATH` (por defecto `./data/bugs-manager.db`) y se
migra al arrancar. Los jobs que estaban esperando respuesta siguen ahí tras un reinicio.

## Guía de credenciales, paso a paso

### 1. Jira Cloud (lectura del ticket)

1. Entra en <https://id.atlassian.com/manage-profile/security/api-tokens> con la cuenta que
   usarás para leer tickets (basta con que tenga permiso de lectura sobre el proyecto `AN`).
2. **Create API token** → ponle un nombre (`bugs-manager`) → copia el token.
3. En `.env`:
   - `JIRA_BASE_URL=https://qrveydev.atlassian.net`
   - `JIRA_EMAIL=` el email de esa cuenta
   - `JIRA_API_TOKEN=` el token copiado

### 2. Jira Cloud (webhook `issue_created`) — OPCIONAL, pendiente

Necesitas ser **administrador de Jira** para este paso (si ves "You do not have permission to
access this page" en Settings → System, no lo eres). **Mientras no tengas ese permiso, deja
`JIRA_WEBHOOK_SECRET` vacío**: el servicio arranca igual, no monta `/webhooks/jira` y el
disparo es solo manual desde Slack. Como alternativa sin admin, en una fase futura añadiremos
un sondeo periódico por JQL que tome los bugs nuevos que aún no gestionamos.

El webhook necesita una URL pública: primero levanta el túnel (paso 5) y vuelve aquí.

1. Genera el secreto que usaremos para firmar y ponlo en `.env`:
   ```bash
   openssl rand -hex 32
   ```
   → `JIRA_WEBHOOK_SECRET=<ese valor>`
2. En Jira: **⚙️ Settings → System → Webhooks** (URL directa:
   `https://qrveydev.atlassian.net/plugins/servlet/webhooks`) → **Create a webhook**.
3. Rellena:
   - **Name**: `Bugs Manager`
   - **Status**: Enabled
   - **URL**: `https://<tu-url-publica>/webhooks/jira`
   - **Secret**: el mismo valor de `JIRA_WEBHOOK_SECRET`. Jira firmará cada petición con
     HMAC-SHA256 en la cabecera `X-Hub-Signature`; el servicio rechaza (401) cualquier
     petición cuya firma no cuadre.
   - **Issue related events → JQL**: `project = AN AND issuetype = Bug`
     (el servicio vuelve a filtrar por proyecto y tipo, pero así Jira no manda ruido)
   - Marca únicamente **Issue → created**.
4. Guarda. Crea un bug de prueba en `AN` y mira el log del servicio.

### 3. Slack (app, tokens y canal)

1. Ve a <https://api.slack.com/apps> → **Create New App → From a manifest** → elige el
   workspace → pega el contenido de [`slack-app-manifest.json`](slack-app-manifest.json) →
   **Create**. El manifest ya trae los scopes, el comando `/fix`, los eventos y Socket Mode.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: nombre
   `socket`, scope `connections:write` → copia el token `xapp-…` → `SLACK_APP_TOKEN`.
3. **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET`.
4. **Install App → Install to Workspace** → autoriza. Luego en **OAuth & Permissions** copia
   el **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
5. Crea (o elige) el **canal privado** donde vivirán los hilos e invita al bot:
   `/invite @bugsmanager`.
6. Obtén el **ID del canal**: abre el canal → clic en el nombre → al final del panel de
   detalles aparece `ID del canal: C0…` o `G0…` → `SLACK_CHANNEL_ID`. Es el ID, no el nombre.
7. Deja `SLACK_SOCKET_MODE=true` en local. Slack no necesita URL pública en este modo.

**Cuando pases al VPS** (modo HTTP): en la configuración de la app desactiva Socket Mode,
y pon `https://<tu-dominio>/slack/events` como Request URL en **Event Subscriptions**,
**Interactivity & Shortcuts** y en el comando **/fix**. En `.env`: `SLACK_SOCKET_MODE=false`
y `PUBLIC_BASE_URL=https://<tu-dominio>`. Bolt verifica la firma de Slack en cada petición.

### 4. Claude Code

Ya tienes `claude` instalado (`~/.local/bin/claude`). El servicio lo invoca como
`claude -p --output-format stream-json --verbose --permission-mode acceptEdits` con una lista
acotada de herramientas (edición de archivos, Bash de npm/npx/node y git de solo lectura; nunca
`git commit`/`push`). Asegúrate de haber iniciado sesión (`claude` en una terminal) con la cuenta
que quieras que use el servicio. No hace falta ningún token en `.env` para local.

Para el VPS, donde no hay navegador para hacer login, hay dos opciones y el servicio hereda la
variable que pongas en `.env`:

- `CLAUDE_CODE_OAUTH_TOKEN`: token de larga duración ligado a tu suscripción Claude. Se genera
  una vez en tu Mac con `claude setup-token` y se copia al `.env` del VPS. Consume tu plan.
- `ANTHROPIC_API_KEY`: clave de <https://console.anthropic.com>. Factura por uso, aparte de la
  suscripción. Si está definida tiene prioridad sobre el login, así que no la dejes puesta en
  local por accidente.

Si en algún momento las sesiones fallan con `401 authentication_error` / `token has been revoked`,
el login del CLI caducó: `claude auth logout` y `claude auth login`.
Cada job tiene una sesión propia; su id queda en el dashboard y permite retomarla a mano con
`claude --resume <id>` dentro del worktree.

### 5. Exponer el puerto local a Jira (túnel)

Jira Cloud debe poder alcanzar tu máquina. Con `cloudflared`:

```bash
brew install cloudflared
```

Túnel rápido (URL aleatoria, cambia cada vez que lo arrancas, sin cuenta):

```bash
cloudflared tunnel --url http://localhost:3000
```

Copia la URL `https://xxxx.trycloudflare.com` que imprime, ponla en `PUBLIC_BASE_URL` y úsala
en el webhook de Jira (`…/webhooks/jira`). Cada vez que reinicies el túnel tendrás que
actualizar la URL del webhook en Jira; si quieres una URL fija necesitas un dominio en
Cloudflare y un *named tunnel* (`cloudflared tunnel login`, `tunnel create`, `tunnel route dns`).

## Probar la fase 1

1. `pnpm dev`. El log debe mostrar `Jira: credenciales OK`, `Slack: bot token OK` y
   `el bot es miembro del canal`.
2. **Disparo manual** desde el canal privado: `@bugsmanager revisa el ticket AN-1234` o
   `/fix AN-1234 desde develop`. En el canal aparece un mensaje raíz con el ticket, su
   estado en Jira y quién lo pidió, más una respuesta en el hilo. Si el ticket está en
   `Done`/`Closed`, el hilo lo dice y se detiene.
3. `GET http://localhost:3000/health` para un ping rápido (`jiraWebhook` indica si la ruta
   del webhook está montada).

Solo si configuraste `JIRA_WEBHOOK_SECRET` (requiere admin de Jira):

4. **Sin túnel**, simula el webhook firmado contra un ticket real: `pnpm simulate:jira AN-1234`
   → `202 {"accepted":true}` y el mismo hilo que en el disparo manual.
   Variantes: `--bad-sig` (espera 401) y `--type Task` (espera 200 ignorado).
5. **Con túnel**, crea un bug real en `AN` y comprueba que llega solo.

## Probar la fase 2

1. `pnpm build:web && pnpm dev`. El log debe mostrar `SQLite abierta y migrada` y
   `Dashboard servido desde dist/web`.
2. Abre <http://localhost:3000>. Estará vacío hasta que pidas algo desde Slack.
3. En el canal: `/fix AN-1234` (sin rama). El job aparece en el dashboard en **Esperando rama**
   con la pregunta destacada, y en el hilo de Slack se hace la misma pregunta.
4. Responde **desde el dashboard** (expande la fila → escribe `develop` → Responder). En el hilo
   de Slack aparece "Respuesta desde el dashboard: develop" y el job pasa a **Recibido**
   con la rama guardada. Alternativamente responde en el hilo de Slack con el nombre de la
   rama: el efecto es el mismo y queda registrado quién respondió.
5. Prueba también `/fix AN-1234 desde develop`: se salta la pregunta. Y un ticket en `Done`:
   el job queda en **Descartado**.
6. Filtra por estado con los chips, busca por clave, expande una fila para ver el log de
   eventos, y usa **Descartar job** en uno activo.
7. Para ver los colores del resto de estados sin trabajo real detrás, con `NODE_ENV=development`
   cada detalle tiene un selector `dev: … → Forzar estado` (no existe en producción).
8. Reinicia el servidor con un job en **Esperando rama**: debe seguir ahí, y el log dice
   `Jobs activos recuperados de la base`.
9. Verifica la actualización en vivo: con el dashboard abierto, responde desde Slack; la fila
   cambia sola sin recargar (indicador `● en vivo`; si SSE cae, pasa a `◌ polling 5s`).

## Repositorios y triaje (fase 5)

El servicio no tiene un repo fijo: usa el clon de `qrvey_platform_knowledge` (`KNOWLEDGE_REPO_PATH`)
como fuente de verdad sobre la plataforma.

- `config/repos_product.manifest` da los **nombres canónicos** de los repos de producto.
- Los clones viven **solo** en `<KNOWLEDGE_REPO_PATH>/repos_product/<repo>`. Si un repo necesario no
  está clonado, el servicio lo clona con `scripts/setup.sh --clone --manifest <manifest temporal>`
  del propio repo de conocimiento (resuelve SSH/HTTPS él mismo), nunca con `git clone` a mano.
- `docs/catalog/` (índice de recuperación, capacidades, perfiles por repo, flujos) es lo que Claude
  lee en el **triaje** para decidir dónde va el fix.

Flujo de un job:

1. Rama origen (desplegable). Se valida contra `BRANCHES_REFERENCE_REPO` o el primer repo clonado.
   La rama debe existir con el mismo nombre en todos los repos implicados, como manda el modelo de
   release de la plataforma.
2. **Triaje** (`Analizando repos`): sesión corta de Claude Code con cwd en el repo de conocimiento,
   solo lectura (también puede leer los clones ya existentes). Devuelve `{"status":"repos",…}` con
   los repos ordenados por probabilidad, motivo y confianza, más un análisis. Si en las notas del
   `/fix` indicas el repo, lo respeta salvo evidencia clara en contra.
3. **Confirmar repos** (`awaiting_repos`): el hilo muestra la propuesta con botones *Confirmar* /
   *Rechazar*; puedes cambiar la lista escribiendo `repos: a, b`. En el dashboard, checkboxes y un
   campo para añadir repos del manifest.
4. **Worktrees**: por cada repo, clonar si falta → `fetch` → `worktree add` en
   `<WORKTREES_DIR>/<KEY>-<ts>/<repo>` con la rama `fix/<KEY>-<ts>` (misma en todos) → copiar
   `COPY_FILES` (global con `{repo}` o `REPO_<NOMBRE>_COPY_FILES`) → instalar dependencias
   (autodetección por lockfile o `REPO_<NOMBRE>_INSTALL_COMMAND`). El primero es el principal.
5. **Fix**: una sola sesión de Claude Code con cwd en el worktree principal, `--add-dir` para los
   demás worktrees (editables) y para el repo de conocimiento (solo lectura). Los tests se ejecutan
   por repo (`TEST_COMMAND` global o `REPO_<NOMBRE>_TEST_COMMAND`).
6. Si a mitad del fix Claude descubre que necesita otro repo, responde `needs_repos` y vuelves al
   paso 3; al confirmar se crea el worktree en la misma rama y la **misma sesión** se reanuda con
   acceso a él. Si rechazas, Claude sigue con lo que tiene o reporta `cannot_fix`.
7. Reporte: archivos cambiados según `git status` de **cada** worktree (prefijo `<repo>/`),
   descontando lo que dejó la instalación (p. ej. un `package-lock.json` regenerado). Limpieza:
   elimina todos los worktrees del job y su directorio.

El servicio no está atado a ningún proyecto de Jira: `/fix`, las menciones y el webhook aceptan
tickets de cualquier proyecto. El repositorio donde se arregla lo determina el triaje.

## Estado del ticket en Jira

Justo después de abrir el hilo, y **antes** de preguntar por la rama, el bot ofrece mover el ticket al
estado de trabajo en curso:

```
¿Muevo AN-1234 en Jira de "Open" a "In Progress"?
  [ Sí, cambiar estado ]  [ No, dejarlo igual ]
```

Con "No" el ticket queda intacto y el flujo sigue igual.

Al terminar, si el bug quedó solucionado, se ofrece lo segundo y último que el bot escribe en Jira:

```
¿Publico el reporte en AN-1234 como comentario con 2 vídeo(s) adjunto(s)?
  [ Sí, publicar ]  [ No publicar ]
```

Publica el mismo reporte que ves en el hilo (Issue, Solution, Notes for QA, rama, archivos, tests,
reproducción y el enlace del PR si se abrió) y adjunta los vídeos de antes y después al ticket. Se intenta incrustarlos bajo sus
etiquetas y, si el sitio de Jira lo rechaza (es lo habitual con adjuntos recién subidos), se reintenta
dejándolos como enlace al adjunto: en ambos casos los vídeos quedan en el ticket. Se puede
publicar también desde el dashboard, y solo una vez por job. Nunca edita campos ni cambia nada más.

La pregunta se omite sola cuando no aplica: si el ticket ya está en ese estado, si tu flujo de Jira no
ofrece esa transición desde donde está, si tu cuenta no tiene permiso, o si pones
`JIRA_ALLOW_TRANSITION=false`. La transición se busca por **estado destino**, no por el nombre del
botón: en el flujo de `AN` la transición se llama "Start Progress" y lleva a "In Progress", y funciona.

Entre el fix y el comentario hay un paso más, el que cierra el ciclo:

```
¿Subo la rama bugfix/AN-1234-… y abro el pull request hacia epic/…?
  [ Sí, subir y abrir PR ]  [ No, lo hago yo ]
```

Al confirmar, el bot commitea los cambios del worktree con `COMMIT_MESSAGE_TEMPLATE`
(`fix(AN-1234): :bug: <título del ticket>`, pasando por los hooks del repo: lint-staged y commitlint),
sube la rama **con su mismo nombre** y abre el PR en Bitbucket hacia la rama origen con la plantilla QA
como descripción. **Nunca empuja a la rama origen ni mergea**: el PR queda abierto para revisión. Si la
rama ya estaba subida o el PR ya existía (porque lo hiciste a mano), lo reutiliza. Un PR por repositorio
tocado. Después ofrece la tercera y última escritura en Jira, mover el ticket a
`JIRA_WAITING_FOR_MERGE_STATUS` ("Waiting for Merge"), y por último el comentario, que ya lleva la
línea `Pull request:` con la tarjeta del PR. Todo con confirmación, y también desde el dashboard.
Se desactiva con `PR_ENABLED=false`; las credenciales son por defecto las de Jira (misma cuenta
Atlassian) y se pueden separar con `BITBUCKET_EMAIL` / `BITBUCKET_API_TOKEN`.

## Reproducción en navegador (Playwright)

Antes de tocar código, el servicio intenta **demostrar el bug**: la misma prueba debe fallar antes
del fix y pasar después. Si no se puede, no se inventa nada: se pregunta.

Preparación, una vez por máquina:

```bash
pnpm exec playwright install chromium
```

Opcional, para que los vídeos salgan en mp4 en lugar de webm:

```bash
brew install ffmpeg
```

El ffmpeg que Playwright instala con los navegadores está compilado al mínimo (solo webm y vp8), así
que no sirve para convertir. Sin un ffmpeg completo los vídeos se publican en webm, que Slack
reproduce igual; en Jira quedan adjuntos al ticket y enlazados desde el comentario.

Cómo funciona, sin configuración por repositorio:

1. **Detección.** Se lee el `package.json` del worktree. Solo las apps con interfaz (Stencil, React,
   Vue, Angular, Vite, Next) entran; el comando de arranque sale de los scripts (`start`, `dev`,
   `serve`). Se puede forzar con `REPO_<NOMBRE>_DEV_COMMAND`.
2. **Servidor propio.** Se arranca en el worktree, en paralelo con la sesión, porque una build de
   Stencil tarda minutos. **El puerto se detecta de su propia salida, nunca se supone**, y después se
   comprueba con `lsof` que quien escucha pertenece a nuestro proceso. Si el puerto lo ocupa otra
   instancia tuya, se aborta: medir contra código ajeno daría un veredicto falso. **Varios jobs del
   mismo repositorio pueden correr a la vez**: cada uno levanta su servidor en su worktree (Stencil
   salta al siguiente puerto libre) y la comprobación de propiedad garantiza que cada prueba mide su
   propio código. El servidor se detiene al terminar el job por cualquier vía; si el job se reanuda
   después, se vuelve a levantar y el harness y el manifiesto se actualizan con la URL nueva.
3. **Harness de embebido.** Se genera una página como la de un cliente, con el objeto de
   configuración del ambiente y **los lanzadores apuntando al servidor local**, no al dominio
   publicado. Eso garantiza que se prueba el código del worktree con datos reales. Se escribe
   **directamente en el directorio que el servidor sirve** (`www/` en Stencil), así se ve al
   instante y las ediciones del agente no dependen de ninguna build; el servicio comprueba por HTTP
   que responde 200 antes de arrancar la sesión, y si no, se lo dice al agente en el prompt.
4. **Rojo y verde.** Claude escribe el spec, lo ejecuta antes del fix (debe fallar), arregla, y lo
   vuelve a ejecutar sin tocarlo (debe pasar). El wrapper (`bin/e2e-run.mjs`) lee un
   `bugs-manager.json` que el servicio deja junto al spec (URL, worktree, directorio servido) y
   **espera él solo** a que la app responda y a que la reconstrucción en watch haya recogido la
   última edición del worktree: el agente tiene prohibido esperar con bucles, y `sleep` no está en
   la lista de comandos permitidos. Además, cada comando Bash de la sesión tiene un tope
   (`CLAUDE_BASH_MAX_TIMEOUT_MINUTES`, 5 por defecto) para que una espera mal hecha no cueste diez
   minutos. El servicio lee los informes de Playwright y decide: afirmar "verificado" sin haberlo
   ejecutado no cuela, queda como `verification_mismatch`.
5. **Evidencia.** Vídeo de antes y después, capturas y traza se guardan en `ARTIFACTS_DIR` (fuera de
   los worktrees, sobreviven a la limpieza), se ven en el dashboard con reproductor y se suben al
   hilo de Slack. Requiere el scope `files:write`: actualiza la app con el manifest y reinstálala.

Ambientes de datos: **todos en `environments.json`** (copia `environments.example.json`; está fuera
de git porque lleva api_keys), con las mismas claves que el objeto de configuración del embebido
(`domain`, `api_key`, `app_id`, `user_id`, `qrveyid`). En el `.env` solo se elige cuál usar con
`E2E_ENV=<nombre>`: si un ambiente falla, se cambia el nombre y se reinicia. El agente **solo
pregunta** en dos casos: si el ambiente elegido no existe o le faltan claves, y si su dominio no
responde (y en ese caso el mensaje lista los otros ambientes del archivo). La api key no sale nunca a
Slack, al dashboard ni a los logs. El esquema antiguo por variables (`E2E_ENVS` + `E2E_ENV_<NOMBRE>_*`)
sigue admitido.

**Sin entorno**, el hilo y el dashboard ofrecen tres botones: *Corregir solo con código* (flujo de
siempre, validado con los tests del repo), *Reintentar entorno* (vuelve a leer `environments.json` y a
levantar el servidor, sin reiniciar el servicio: para después de corregir la configuración o liberar el
puerto) o *Descartar*. Lo mismo si Claude no consigue reproducirlo.

### Banco de pruebas

```bash
pnpm smoke
```

Monta un repo de conocimiento, remotos git y una app con un bug real, y ejercita el ciclo completo
con un Claude simulado: camino feliz, discrepancia entre lo que dice el agente y lo que dicen los
informes, servidor que se reconstruye con retraso (como Stencil: el wrapper debe esperar antes de
la fase *after*), servidor que no arranca, y puerto ocupado por otro proceso. No gasta tokens.

## Reporte de un fix (plantilla QA)

Cuando un job termina en **Solucionado**, el hilo de Slack y el detalle del dashboard muestran el
reporte en inglés con esta plantilla, que Claude rellena en el bloque JSON del contrato
(`issue`, `solution`, `notes_for_qa` opcional):

```
🎉 AN-1234 fixed

*Issue:*
What was wrong and why (symptom + root cause).

*Solution:*
What changed and why it fixes the root cause, per repository touched.

*Notes for QA:*            ← only when there is something to verify or a side effect
Related tickets to re-check, pre-existing failing tests, impacted areas.

*Branch:* bugfix/AN-1234-20260918-192250
*Worktrees:* repo → path        *Files (n):* …        *Tests:* passed|failed|none — detail
*Regression test:* verified (unit) — src/x.spec.ts fails without the fix and passes with it
*Reproduction:* verified (the test fails without the fix and passes with it)
```

En el comentario de Jira va la misma plantilla **sin** la lista de archivos ni el pie: solo Issue,
Solution, Notes for QA, Branch, Pull request, Tests, Regression test, Reproduction y los vídeos.

### Spec de regresión obligatorio

Cada fix debe quedar cubierto por un spec **del repositorio** que falle sin el fix y pase con él; la
prueba de Playwright del harness es evidencia para QA y no cuenta porque vive fuera del repo. El
protocolo es el mismo que el de la reproducción: Claude escribe el spec antes de tocar el código, lo
ejecuta con `bin/unit-run.mjs --phase before` (debe fallar), aplica el fix y lo vuelve a ejecutar con
`--phase after` y el mismo comando (debe pasar). El wrapper deja un registro por fase y el servicio
exige: mismo spec, mismo comando, rojo → verde, y el spec entre los archivos del fix. Solo se usa la
infraestructura de tests que el repo ya tiene (Stencil, Jest, Vitest, Mocha…); nunca se añaden
dependencias. Si el veredicto no es `verified`, se le pide a Claude una vez con el motivo exacto; si
sigue sin spec, el job se detiene y una persona decide en el hilo o el dashboard: *Aceptar sin spec*
(queda marcado en Slack, Jira y el PR) o *Descartar*. `REGRESSION_SPEC_REQUIRED=false` lo deja en
solo informativo.

Los mismos campos quedan en la base (`issue`, `solution`, `notes_for_qa`) y servirán como
descripción del PR cuando exista `ENABLE_PR`. Si Claude no rellena la plantilla, se usa el
`summary` libre como *Issue* para no perder información.

## Notas adicionales para Claude

Puedes complementar el ticket con contexto tuyo al pedir el fix. Se guarda en el job, se muestra
en el hilo raíz y en el dashboard, y entra en el prompt como "Notas del equipo" con prioridad
sobre el ticket si se contradicen.

```
/fix AN-1234 ten en cuenta el componente X, que tiene la función Y
/fix AN-1234 desde develop: el bug está en an-datagrid, no en el dashboard
@bugsmanager revisa AN-1234: fíjate en el listener de preferencias
```

En `/fix`, todo lo que sigue a la clave (quitando `desde <rama>`) son notas. En menciones hacen
falta dos puntos o un salto de línea tras la clave, para no tomar "revisa el ticket" como nota.

## El hilo como chat de Claude Code

Cualquier mensaje que escribas en el hilo del ticket (o en el cuadro "Mensaje para Claude Code"
del dashboard) llega a la sesión. Qué pasa depende del estado del job:

| Estado del job | Qué hace tu mensaje |
|---|---|
| Esperando rama / aclaración | Es la respuesta a la pregunta pendiente. |
| Trabajando | Se encola ("Anotado") y se entrega en cuanto Claude termina el turno, reanudando la sesión. Si el turno terminó en preguntas, tus mensajes se le pasan junto con ellas. |
| Solucionado / No se pudo / Fallido | Reabre el job a Trabajando y reanuda la misma sesión con tu instrucción, con todo el contexto previo. Requiere que el worktree siga en disco. |
| Creando worktree | Se añade a las notas, que entran en el primer prompt. |
| Descartado | Se ignora; pide `/fix` de nuevo. |

Así puedes decir "también ajusta el test" o "no era ahí, mira el sort-panel" tras un fix, igual
que en el chat interactivo. Cada reanudación queda en la transcripción y en el log de eventos.

## Probar la fase 4

Antes, en `.env`: `TEST_COMMAND` con el comando de tests del repo (o vacío para `tests: none`).
`claude` debe estar autenticado para tu usuario (abre `claude` en una terminal si no lo has hecho).

1. `/fix AN-1234`, elige la rama. Tras el worktree, el hilo dice `Claude Code iniciado` con un
   enlace al dashboard que abre el job expandido. El job está en **Trabajando**.
2. En el dashboard, el detalle muestra el panel **Sesión de Claude Code** en vivo: cada texto del
   agente, cada herramienta (Read, Edit, Bash…) con su entrada y su resultado plegables, y el
   cierre de cada ejecución con turnos, duración y coste. Se guarda en SQLite: puedes releerlo
   después de un reinicio.
3. Si Claude pregunta, el job pasa a **Esperando aclaración** con las preguntas numeradas en el
   hilo y en el dashboard. Responde en cualquiera de los dos: la misma sesión se reanuda
   (`claude --resume`) y el panel sigue donde estaba. Máximo `MAX_CLARIFICATION_ROUNDS` rondas;
   la siguiente pasa a **No se pudo**.
4. Al terminar, el hilo publica: `El bug AN-1234 fue solucionado en la rama … del worktree …`,
   con resumen, archivos tocados (según `git status`, no según Claude) y resultado de tests.
   Nada se commitea: revisa el diff en el worktree. Si no pudo, el motivo.
5. **Permisos.** La sesión carga solo tu configuración de usuario de Claude Code
   (`CLAUDE_SETTING_SOURCES=user`). Si cargara la del repo (`.claude/settings.json`) y esta
   tuviera reglas `ask` para `Edit`/`Write`, en headless nadie podría contestar y Claude no
   podría tocar nada. El servicio inyecta de todas formas un `deny` de lectura para `.env`,
   claves y credenciales. Si en la sesión aparecen denegaciones, el job lo registra
   (`permissions_denied`) y lo dice en Slack. Y si Claude reporta `fixed` pero `git status`
   está limpio, el job pasa a **Fallido** en vez de fingir un arreglo.
6. Casos de fallo: si Claude termina sin el bloque JSON se le pide una vez más antes de marcar
   **Fallido**; si pasa `CLAUDE_IDLE_TIMEOUT_MINUTES` sin emitir nada (colgado) o supera el tope absoluto `JOB_TIMEOUT_MINUTES` se mata el proceso y queda **Fallido** con el
   worktree conservado. **Descartar job** durante la sesión mata el proceso.
7. Si reinicias el servicio con un job en **Trabajando**, al arrancar pasa a **Fallido** con el
   id de sesión en el motivo, para retomarla a mano con `claude --resume <id>` dentro del worktree.
   Los jobs en espera (rama o aclaración) sobreviven intactos.

Para probar sin gastar tokens, `CLAUDE_BIN` puede apuntar a un script que emita `stream-json`
falso (ver `--output-format stream-json` en `claude --help`).

## Probar la fase 3

Antes, en `.env`: `KNOWLEDGE_REPO_PATH` (clon de `qrvey_platform_knowledge`), `WORKTREES_DIR` y,
si aplica, `COPY_FILES` u overrides `REPO_<NOMBRE>_*`. Al arrancar, el log avisa si el repo de
conocimiento, el manifest o `repos_product` no existen. (Sección escrita para un solo repo; el
flujo multi-repo se describe en "Repositorios y triaje".)

1. `/fix AN-1234` en el canal. En el hilo aparece la pregunta con un **desplegable con búsqueda**:
   al abrirlo muestra las ramas del remoto (`develop`, `main` y `release/*` primero) y al escribir
   filtra entre todas (sirve aunque haya más de mil). Elige una.
2. El job pasa a **Creando worktree** y, al terminar, el hilo muestra la ruta, la rama
   `fix/AN-1234-<timestamp>`, los archivos copiados y el tiempo de instalación. El job queda en
   **Trabajando** (la fase 4 lanzará Claude Code ahí). Comprueba con `git -C $REPO_PATH worktree list`.
3. Repite escribiendo la rama como texto en el hilo, o desde el dashboard (el campo sugiere las
   ramas del remoto). Una rama inexistente se rechaza y el job sigue esperando.
4. `/fix AN-1234 desde release/9.5` se salta la pregunta y crea el worktree directamente.
5. Fuerza un fallo (p. ej. `INSTALL_COMMAND=exit 1`): el job queda en **Fallido** con el paso y la
   cola de la salida en el hilo, y el worktree a medias se elimina solo.
6. Limpieza: en un job terminado, botón **Eliminar worktree del disco** en el detalle, o
   **Limpiar worktrees cerrados** en la barra superior para todos a la vez. Por consola:

```bash
pnpm worktrees:cleanup --dry-run
```

La limpieza borra el directorio y la rama local; **nunca** toca el remoto ni hace commit.

## DABOT: la app de voz (Android)

DABOT es una tercera forma de manejar los mismos jobs, además del hilo de Slack y el dashboard. Le
hablas a una tablet y responde con cara, voz y pantalla. No arregla nada en la tablet: interpreta lo
que dices y llama a las mismas funciones que los botones, así que **las confirmaciones de Jira, PR y
comentario son exactamente las mismas** y todo queda también en el hilo de Slack (con :microphone:).

```
Tablet                                          Bugs Manager (este servicio)
 "Dabot"  → Vosk offline (palabra de activación)
 comando  → reconocedor de Android → POST /api/voice/command → misma lógica que /fix y los botones
 voz      ← síntesis de Android    ← respuesta + anuncios SSE (GET /api/voice/events)
```

### Qué le puedes decir

| Frase | Qué hace |
|---|---|
| "Dabot…" *(pitido)* "arregla el ticket A N 1234" | Como `/fix AN-1234`. También "a ene mil doscientos treinta y cuatro" o solo "el 1234" (proyecto `VOICE_DEFAULT_PROJECT`, y te lo confirma). |
| "…arregla el 1234 desde develop, ten en cuenta el datagrid" | Rama origen (se empareja con las ramas del remoto: "release barra 9 punto 5" → `release/9.5`) y notas para Claude. |
| "sí" / "no" / "la dos" | Responde lo pendiente: estado en Jira, rama, repos, entorno, spec de regresión, PR, "Waiting for Merge", comentario. |
| *(cuando Claude pregunta)* cualquier frase | Va tal cual a la sesión, como responder en el hilo. |
| "dile a Claude que…" | Mensaje libre a la sesión (encola, responde o reabre, igual que el hilo). |
| "¿cómo va todo?" | Resumen de los jobs activos y lo que te espera. |
| "descarta el ticket" | Pide confirmación antes de descartar. |
| "repite" / "nada" | Repite lo último / cancela. |

DABOT anuncia solo cada cambio relevante (pregunta nueva, Claude trabajando, fix terminado, fallo) y,
si espera respuesta, vuelve a escuchar sin que digas "Dabot". Las opciones también se pueden tocar en
pantalla. Con texto suelto y nada pendiente **no** manda nada a Claude: un falso "Dabot" no tiene efectos.

### Servidor

Ya va incluido: `src/voice/` (intérprete de frases, decisión pendiente por job, texto para voz, anuncios)
y las rutas `/api/voice/{state,command,jobs/:id/decide,events}`. Variables en `.env.example`
(`VOICE_TOKEN`, `VOICE_DEFAULT_PROJECT`, `VOICE_PROJECTS`, `VOICE_ANNOUNCE`). Tests: `pnpm test`.

La tablet tiene que alcanzar el puerto del servicio. Opciones:
- **Misma red Wi-Fi**: `http://<IP del Mac>:3000` (en macOS: `ipconfig getifaddr en1`, o en0).
- **Tailscale** (recomendado, funciona fuera de casa y sin abrir nada a internet): instala Tailscale en la
  tablet con tu cuenta y usa `http://<nombre-del-mac>.<tu-tailnet>.ts.net:3000`.
No uses el túnel de cloudflared para la tablet: expondría la API a internet.

### Compilar e instalar la app

```bash
cd android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleRelease
```

El primer build descarga el modelo de voz de Vosk (40 MB, a `android/.vosk-cache/`). El APK queda en
`android/app/build/outputs/apk/release/app-release.apk` (firmado con tu clave de debug). Pásalo a la
tablet (USB, Quick Share o Drive), ábrelo y permite "instalar apps desconocidas" para esa app.

En la tablet, la primera vez:
1. Concede **micrófono** y **notificaciones**.
2. En **Ajustes** de DABOT: URL del servidor, token si lo usas, idioma. "Probar voz" para oírla.
3. **Abrir solo al encender**: concede "Aparecer encima" (Android solo deja abrir una app al arrancar con
   ese permiso) y **Quitar restricciones de batería**.
4. En Ajustes de Samsung: *Batería → Límites de uso en segundo plano → Apps que nunca se suspenden* →
   añade DABOT. Déjala enchufada y activa *Batería → Proteger batería* (carga al 85 %).

La pantalla queda siempre encendida y se atenúa tras unos minutos sin actividad (configurable); cualquier
anuncio o "Dabot" la despierta. Tocar la cara = hablar; mantenerla pulsada = callar.

### Límites conocidos

- **Di "Dabot", espera el pitido y habla.** El detector decide al terminar la frase: si lo dices todo de
  un tirón, DABOT responde "Dime" y tienes que repetir el comando.
- La palabra de activación se midió con voces sintéticas (26/30 detecciones, 1 falso positivo en 120
  frases de oficina). Con tu voz real puede variar; si falla mucho, toca la cara.
- El comando lo transcribe el reconocedor de Google de la tablet: necesita internet.
- La síntesis usa las voces instaladas en la tablet (Ajustes → Administración general → Texto a voz). La
  voz de Google en español suena mejor que la de Samsung.

## Estructura

```
src/
  index.ts             arranque: config, logger, SQLite, jobs, Slack, HTTP, credenciales
  config.ts            variables de entorno validadas con zod
  logger.ts            pino; ticketLogger(key) añade la clave a cada línea
  types.ts             IncomingBug, JiraIssue, ThreadRef
  intake.ts            orquestador: disparadores → job → Jira → hilo; respuestas humanas
  server.ts            rutas HTTP: /health, webhook, /api (con auth básica opcional), dist/web
  shared/job-types.ts  estados, etiquetas y DTOs compartidos con el frontend
  db/schema.ts         tablas jobs y job_events (Drizzle)
  db/index.ts          abre SQLite y aplica ./drizzle al arrancar
  jobs/repository.ts   acceso a datos
  jobs/service.ts      transiciones de estado, bitácora, emite 'job' para SSE
  api/router.ts        GET /api/jobs, /api/jobs/:id, POST answer/discard, /api/events (SSE), /api/dev
  api/sse.ts           hub de Server-Sent Events con heartbeat
  api/auth.ts          auth básica (activa solo con DASHBOARD_BASIC_AUTH_*)
  repos/registry.ts    manifest de qrvey_platform_knowledge, clones en repos_product, clonado bajo demanda, overrides por repo
  git/worktree.ts      ls-remote, fetch, worktree add -b fix/KEY-timestamp por repo, copia de archivos, install (autodetect), remove
  claude/runner.ts     lanza `claude -p --output-format stream-json`, reanuda sesiones, timeout, kill
  claude/prompt.ts     system prompt con las reglas y el contrato JSON; prompt inicial y de reanudación
  claude/outcome.ts    extrae y valida el bloque JSON final (needs_clarification | fixed | cannot_fix)
  claude/messages.ts   convierte eventos stream-json en mensajes legibles para la transcripción
  util/exec.ts         ejecución de procesos con timeout y cola de salida
  scripts/cleanup-worktrees.ts   limpieza por consola (pnpm worktrees:cleanup)
  jira/client.ts       cliente REST v3: lectura, transición y comentario (las escrituras, siempre confirmadas)
  jira/comment.ts      reporte del fix en ADF (con tarjeta del PR y vídeos)
  git/publish.ts       commit con plantilla, push de la rama con su nombre (nunca a la origen)
  scm/bitbucket.ts     cliente mínimo de Bitbucket Cloud: buscar/abrir pull requests
  jira/webhook.ts      POST /webhooks/jira: firma HMAC, filtros de proyecto/tipo
  slack/app.ts         Bolt en Socket Mode o HTTP (ExpressReceiver montado en Express)
  slack/notifier.ts    abrir hilo / responder en hilo
  slack/handlers.ts    @mención, /fix y respuestas en hilo → intake
  scripts/simulate-jira-webhook.ts
  voice/parse.ts       frases de voz → intención (clave deletreada, rama, notas, sí/no/opción)
  voice/decision.ts    qué espera cada job de una persona (mismas reglas que Slack y dashboard)
  voice/speech.ts      mrkdwn de Slack → texto para pantalla y para la síntesis de voz
  voice/service.ts     DABOT: comandos, decisiones y anuncios por SSE
  voice/router.ts      /api/voice (state, command, decide, events)
android/               app DABOT (Kotlin + Compose): cara, Vosk "Dabot", reconocedor y voz de Android
drizzle/               migraciones SQL generadas (pnpm db:generate tras cambiar el schema)
web/                   dashboard React + Vite (compila a dist/web)
  src/App.tsx          filtros, búsqueda, lista
  src/useJobs.ts       carga REST + SSE con respaldo de polling
  src/components/      JobRow, JobDetail (responder, descartar, log), StatusBadge, CopyButton
```

## Plan de fases

1. ✅ Esqueleto: Express, app de Slack que abre hilos, disparo manual; webhook de Jira firmado (opcional, pendiente de permisos de admin).
2. ✅ Persistencia (SQLite + Drizzle), modelo de jobs con bitácora, dashboard en vivo (SSE) con
   filtros, búsqueda, detalle, respuesta y descarte desde el dashboard o desde el hilo.
3. ✅ Worktrees: desplegable de ramas del remoto en Slack y dashboard, `fetch` + `worktree add`
   con rama `fix/KEY-timestamp`, copia de archivos, instalación de dependencias, limpieza.
4. ✅ Claude Code headless: stream-json en vivo al dashboard y a SQLite, contrato JSON, sesión
   reanudable con aclaraciones desde Slack o dashboard, timeout, reintento sin JSON, huérfanos.
5. ✅ Multi-repositorio: triaje sobre el catálogo de `qrvey_platform_knowledge`, confirmación de
   repos con botones, un worktree por repo en la misma rama, clonado bajo demanda, `needs_repos`
   a mitad del fix, reporte y limpieza por repo. El hilo funciona como el chat de Claude Code.
6. **PRÓXIMO — Modo automático por sondeo de Jira.** Sin permisos de administrador no hay webhook,
   así que el servicio consultará Jira cada X tiempo (JQL, p. ej. `issuetype = Bug AND created >= -1d`)
   y creará un job por cada ticket nuevo que aún no gestione (idempotente por clave). Variables ya
   reservadas en `.env.example`: `JIRA_POLL_INTERVAL_SECONDS`, `JIRA_POLL_JQL`. Debe pasar por el
   mismo camino que `/fix`: hilo, rama, triaje, confirmación.
7. Idempotencia con botones (reintentar / nuevo job / descartar), límite de jobs concurrentes,
   push y PR opcionales tras variable (nunca commit automático), Dockerfile y unidad de systemd.
8. Mejoras anotadas en las pruebas: `failed_preexisting` en tests, adjuntos de Jira al prompt,
   aislar MCP personales de la sesión, prefijo opcional para mensajes del hilo dirigidos a Claude.

## Reglas fijas

- En Jira el bot solo escribe en tres momentos, y **los tres los confirmas tú**: mover el ticket a
  `JIRA_IN_PROGRESS_STATUS` al empezar, moverlo a `JIRA_WAITING_FOR_MERGE_STATUS` tras abrir el PR, y
  publicar el reporte del fix como comentario al terminar. Nunca edita campos. Se desactivan con
  `JIRA_ALLOW_TRANSITION=false`, `JIRA_WAITING_FOR_MERGE_STATUS=` (vacío) y `JIRA_ALLOW_COMMENT=false`.
- **Nunca** push a la rama origen ni merge automático. El commit y el push de la rama `bugfix/…` solo
  ocurren cuando confirmas "Subir y abrir PR" en el hilo o en el dashboard, y el PR queda abierto
  para revisión. `PR_ENABLED=false` lo desactiva del todo.
- Ninguna petición sin firma válida (Jira o Slack) se procesa.
- Cada línea de log de un ticket lleva `ticket: "AN-1234"`.
