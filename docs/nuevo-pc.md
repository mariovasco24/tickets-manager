# Montar tickets-manager en un PC nuevo

Guía para dejar el PC nuevo funcionando **igual que el Mac actual**, con la misma configuración,
tokens, llaves, base de datos y sesiones de Claude. Está escrita para que Claude Code la siga paso a
paso en el PC nuevo; tú solo tienes que aportar el paquete cifrado, su contraseña y los inicios de sesión.

> **Para Claude.** Sigue las secciones en orden y confirma cada verificación antes de seguir.
> No muestres nunca valores del `.env`, de `environments.json` ni llaves privadas: para comprobar
> si una variable está definida, enseña solo su nombre. El paquete `*.tar.gz.enc` y su contraseña
> no van nunca a git, a un chat ni a ningún servicio externo. Los pasos que piden contraseñas
> (`claude auth login`, la contraseña del paquete o la de la llave SSH) los teclea el usuario.

## Qué se lleva y cómo

Lo que está en git llega con `git clone`. Todo lo demás lo empaqueta `scripts/migrate/export-secrets.sh`
en **un único archivo cifrado** (AES-256 con contraseña) y lo restaura `scripts/migrate/import-secrets.sh`.

| Qué | Dónde vive | Para qué |
| --- | --- | --- |
| `.env` | repo | Jira, Slack, Bitbucket, tokens de la API externa y menciones |
| `environments.json` | repo | Ambientes de datos de Playwright (api_keys de demo, qaaws1 y qaaws5) |
| `.claude/settings.local.json` | repo | Permisos de Claude Code en este proyecto |
| `data/bugs-manager.db` | repo | Historial de jobs (copia consistente, aunque el servidor esté corriendo) |
| `data/artifacts/` | repo | Vídeos y trazas de Playwright. **Opcional** (unos 4 GB): `--con-artefactos` |
| `~/.ssh/id_ed25519` (+ `.pub`, `config`, `known_hosts`) | home | Acceso SSH a Bitbucket (catálogo y repos de producto) |
| `~/.ssh/bugs_tunnel_ed25519` (+ `.pub`) | home | Túnel inverso al VPS `89.117.56.211` (API externa y bugs-hub) |
| `~/Library/LaunchAgents/me.mariovasco.bugs-manager-tunnel.plist` | home | Mantiene ese túnel abierto (puerto 9077 del VPS → 3000 local) |
| `~/analytiq_widget/.env` | home | Se copia a cada worktree de analytiq_widget (`REPO_ANALYTIQ_WIDGET_COPY_FILES`) |
| `~/.claude/settings.json` | home | Ajustes de usuario de Claude Code (modelo, hooks) |
| `~/.claude/projects/*tickets-manager*`, `*Bugs-Manager*`, `*qrvey-platform-knowledge*` | home | Sesiones y memoria de Claude Code de estos proyectos. Se omiten con `--sin-sesiones` |

**No se lleva** (se regenera o se vuelve a clonar):

- `node_modules/` y `dist/`, que se regeneran con `pnpm install` y `pnpm build:web`.
- `~/qrvey_platform_knowledge` y sus `repos_product/`, que se clonan de Bitbucket.
- `~/worktree/`, que ocupa unos 53 GB. Ahora mismo no hay ningún job activo (todos están en `fixed`,
  `failed`, `discarded` o `cannot_fix`), así que no hace falta.
- El inicio de sesión de Claude Code, que se guarda en el llavero de macOS y no se puede exportar:
  se repite `claude auth login`.

## 1. En el PC viejo, antes de irte

1. **Sube lo pendiente.** En `~/tickets-manager`, `git status` debe salir limpio y al día con
   `origin/main`. Revisa también `~/qrvey_platform_knowledge`: si tiene cambios locales que quieras
   conservar, súbelos a una rama, porque el clon del PC nuevo saldrá limpio.

2. **Crea el paquete cifrado.** Pide una contraseña (dos veces). Usa una larga y guárdala aparte:

   ```bash
   scripts/migrate/export-secrets.sh
   ```

   Deja `~/Desktop/tickets-manager-migracion-<fecha>.tar.gz.enc`, de unos 150 MB sin artefactos.
   Para llevarte también los vídeos de Playwright, añade `--con-artefactos`.

3. **Comprueba que se abre** antes de confiar en él (solo lista el contenido, no toca nada):

   ```bash
   scripts/migrate/import-secrets.sh ~/Desktop/tickets-manager-migracion-*.tar.gz.enc --listar
   ```

4. **Guárdalo.** Llévalo en un USB o en el gestor de contraseñas, y la contraseña por otro canal.

5. **Apaga el servicio en el PC viejo** si se va a quedar encendido. Dos instancias a la vez se
   pisan: Slack en Socket Mode reparte los eventos entre ambas, y el túnel solo puede tener el
   puerto 9077 del VPS una vez (el segundo falla con `ExitOnForwardFailure`).

   ```bash
   launchctl bootout gui/$(id -u)/me.mariovasco.bugs-manager-tunnel
   ```

   Después corta `pnpm dev` (Ctrl+C) en la terminal donde esté corriendo.

## 2. En el PC nuevo: requisitos

Se asume **macOS**. Si es Windows o Linux, mira [la sección del final](#si-el-pc-nuevo-no-es-un-mac).

1. **Herramientas de línea de comandos** (traen git, sqlite3 y openssl):

   ```bash
   xcode-select --install
   ```

2. **Node 24 y pnpm.** Con nvm o con el instalador de nodejs.org; luego activa pnpm con corepack
   (la versión la fija `package.json`):

   ```bash
   nvm install 24 && nvm use 24
   ```

   ```bash
   corepack enable pnpm
   ```

3. **Claude Code** e inicio de sesión con la misma cuenta (el usuario lo hace en el navegador):

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   ```bash
   claude auth login
   ```

   El servicio lanza `claude` con `CLAUDE_BIN=claude`, así que tiene que estar en el `PATH` de la
   terminal donde arranques `pnpm dev`.

4. **jq**, solo si vas a usar `hub/clients/bugs-listen.sh` (con Homebrew: `brew install jq`).

## 3. Clonar el repo e importar el paquete

Clónalo **en la misma ruta que en el PC viejo** (`~/tickets-manager`). Si además tu usuario de macOS
se llama igual (`qrvey`), las sesiones de Claude aparecen tal cual. Si cambian, el script de importación
renombra las carpetas y corrige las rutas, pero la ruta idéntica es lo más seguro.

```bash
git clone https://github.com/mariovasco24/tickets-manager.git ~/tickets-manager
```

Copia el paquete al PC nuevo (por ejemplo a `~/Downloads`) e impórtalo. Pide la contraseña:

```bash
cd ~/tickets-manager && scripts/migrate/import-secrets.sh ~/Downloads/tickets-manager-migracion-*.tar.gz.enc
```

Si un archivo ya existía y era distinto, se conserva como `<archivo>.antes-de-migrar-<fecha>`
(pasa, por ejemplo, con el `~/.claude/settings.json` que crea Claude al instalarse).

## 4. Después de importar

1. **Llave de Bitbucket.** Si tiene contraseña, guárdala en el llavero (el `~/.ssh/config` ya
   trae `UseKeychain yes`) y comprueba el acceso:

   ```bash
   ssh-add --apple-use-keychain ~/.ssh/id_ed25519
   ```

   ```bash
   ssh -T git@bitbucket.org
   ```

   Tiene que responder `authenticated via ssh key`.

2. **Catálogo y repos de producto.** `KNOWLEDGE_REPO_PATH=~/qrvey_platform_knowledge`:

   ```bash
   git clone git@bitbucket.org:qrvey/qrvey_platform_knowledge.git ~/qrvey_platform_knowledge
   ```

   Los repos de producto van en `~/qrvey_platform_knowledge/repos_product/<repo>`. Se clonan con los
   scripts de ese repo (`scripts/checkout_repos.sh`; lee su README) o bajo demanda cuando un job los
   necesita. Como mínimo hace falta `analytiq_widget`, que es `BRANCHES_REFERENCE_REPO`.

3. **Dependencias, navegador de Playwright y dashboard:**

   ```bash
   cd ~/tickets-manager && pnpm install
   ```

   ```bash
   pnpm exec playwright install chromium
   ```

   ```bash
   pnpm build:web
   ```

4. **Arrancar** y comprobar el log (ver también «Cómo saber que arrancó bien» en el README):

   ```bash
   pnpm dev
   ```

   Tienen que salir `HTTP escuchando en http://localhost:3000`, `Jira: credenciales OK`,
   `Slack: bot token OK`, `Slack: el bot es miembro del canal` y `Slack Socket Mode conectado`.
   El dashboard en <http://localhost:3000> debe mostrar el historial de jobs del PC viejo.

5. **Túnel al VPS** (solo con el del PC viejo ya apagado; ver el paso 5 de la sección 1):

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/me.mariovasco.bugs-manager-tunnel.plist
   ```

   ```bash
   launchctl print gui/$(id -u)/me.mariovasco.bugs-manager-tunnel | grep -E 'state|last exit'
   ```

   Debe decir `state = running`. Si se reinicia en bucle, mira los logs que indica el plist
   (`StandardErrorPath`). Las causas habituales son que el PC viejo aún tenga el puerto o que falte
   el host del VPS en `known_hosts` (viene en el paquete).

6. **Prueba de punta a punta.** En el canal de Slack, `/fix AN-<un ticket de prueba>`: debe abrir
   hilo, hacer el triaje y crear el worktree en `~/worktree`.

## 5. Cosas que dependen de la red o del aparato

- **DABOT (tablet Android).** La app apunta a una URL del servidor que se guarda en la propia app
  (Ajustes → URL del servidor), normalmente la IP local del Mac (`http://192.168.x.x:3000`). En el
  PC nuevo y en otra red, cámbiala por la IP nueva. `VOICE_TOKEN` está vacío, así que `/api/voice`
  solo es seguro dentro de tu red local; si vas a exponerlo, define `VOICE_TOKEN` en el `.env` y en
  la app.
- **Accesorios del escritorio** (robot ESP32, pantallas Turing y DABOT screen, Stream Deck). No forman
  parte de tickets-manager y no se migran. Los hooks de `~/.claude/settings.json` avisan al robot en
  `127.0.0.1:8765`; sin el robot fallan en silencio y no molestan.
- **`PUBLIC_BASE_URL`** sigue con el valor de ejemplo porque Slack va en Socket Mode y el webhook de
  Jira no está activo. No hay que tocarlo.

## Sesiones de Claude Code

Las sesiones de Claude Code (CLI y pestaña Code de la app de escritorio) se guardan **solo en el
disco**, en `~/.claude/projects/<ruta-del-proyecto-codificada>/`. Instalar Claude en otro PC no las
trae. El paquete se las lleva junto con la memoria del proyecto (`memory/`), y en el PC nuevo:

```bash
cd ~/tickets-manager && claude --resume
```

lista las conversaciones anteriores de este proyecto para retomarlas. La memoria se carga sola en
cada sesión nueva. Las conversaciones de claude.ai (web, pestaña Chat) sí se sincronizan con la
cuenta y no hace falta llevarlas.

## Si el PC nuevo no es un Mac

Los scripts de migración y el túnel están hechos para macOS (`launchd`, `sed -i ''`, llavero).

- **Windows.** Usa WSL2 (Ubuntu) y trata todo lo de esta guía como Linux, con el repo dentro del
  sistema de archivos de WSL (`~/tickets-manager`), no en `/mnt/c`.
- **Linux o WSL2.** En `import-secrets.sh`, cambia `sed -i ''` por `sed -i`. El LaunchAgent no sirve:
  copia sus argumentos (el comando `ssh -N … -R 127.0.0.1:9077:127.0.0.1:3000 root@89.117.56.211`)
  a un servicio de usuario de systemd con `Restart=always`. `ssh-add --apple-use-keychain` no existe;
  usa `ssh-add` a secas. Lo demás (Node, pnpm, Claude, Playwright) es igual.
