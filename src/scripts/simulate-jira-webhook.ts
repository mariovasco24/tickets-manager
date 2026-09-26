/**
 * Simula el webhook `jira:issue_created` de Jira Cloud contra el servicio local,
 * firmándolo con JIRA_WEBHOOK_SECRET igual que hace Jira. Sirve para probar el
 * flujo sin túnel ni crear tickets reales.
 *
 *   pnpm simulate:jira AN-1234            # clave real: el servicio la leerá en Jira
 *   pnpm simulate:jira AN-1234 --bad-sig  # comprueba que una firma inválida devuelve 401
 *   pnpm simulate:jira AN-1234 --type Task # comprueba el filtro de issuetype
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('--')) ?? 'AN-1';
const badSig = args.includes('--bad-sig');
const typeIdx = args.indexOf('--type');
const issueType = typeIdx >= 0 ? (args[typeIdx + 1] ?? 'Bug') : 'Bug';

const secret = process.env.JIRA_WEBHOOK_SECRET;
if (!secret) {
  console.error('Falta JIRA_WEBHOOK_SECRET en .env');
  process.exit(1);
}
const port = process.env.PORT ?? '3000';
const url = `http://localhost:${port}/webhooks/jira`;

const payload = {
  timestamp: Date.now(),
  webhookEvent: 'jira:issue_created',
  issue_event_type_name: 'issue_created',
  user: { displayName: 'Simulador local' },
  issue: {
    id: '10000',
    key,
    fields: {
      summary: 'Bug simulado desde el script local',
      issuetype: { name: issueType },
      project: { key: key.split('-')[0] },
    },
  },
};

const body = JSON.stringify(payload);
const sig = createHmac('sha256', badSig ? `${secret}-mal` : secret).update(body).digest('hex');

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature': `sha256=${sig}` },
  body,
});
console.log(`POST ${url} → ${res.status} ${await res.text()}`);
