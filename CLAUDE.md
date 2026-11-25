# tickets-manager (Bugs Manager)

Orquestador Jira → Slack → Claude Code. El README explica la arquitectura, las credenciales y las fases.

- **Instalar en un PC nuevo o migrar desde otro:** sigue [docs/nuevo-pc.md](docs/nuevo-pc.md) paso a paso.
  Los secretos (`.env`, `environments.json`, llaves SSH, túnel, base de datos, sesiones) llegan en un paquete
  cifrado que restaura `scripts/migrate/import-secrets.sh`.
- Nunca muestres valores del `.env`, de `environments.json` ni llaves privadas; para comprobar que algo está
  definido, enseña solo el nombre. Nunca subas a git el paquete `*.tar.gz.enc`.
- Usa pnpm, no npm. Comprobaciones: `pnpm typecheck` y `pnpm test`.
