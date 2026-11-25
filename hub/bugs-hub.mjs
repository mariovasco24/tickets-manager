#!/usr/bin/env node
/**
 * bugs-hub: punto de entrada público y único para el agente de QA. Recibe peticiones de fix con el
 * email del desarrollador responsable y se las hace llegar a ese desarrollador, tenga el sistema que tenga.
 *
 * Modos de entrega por desarrollador:
 *   - webhook      El hub hace POST de un evento JSON firmado (HMAC-SHA256) a la URL del dev, con reintentos.
 *   - inbox        El dev consulta GET /external/v1/inbox cuando quiera (sin servidor, sin URL pública), o se queda
 *                  conectado a GET /external/v1/stream (Server-Sent Events) y recibe los avisos al instante.
 *   - bugs-manager El hub reenvía la petición al bugs-manager del dev (flujo automático completo).
 * En webhook e inbox el estado lo guarda el hub y lo actualiza el dev con POST /fix-requests/{id}/status.
 *
 * Sin dependencias: solo Node >= 20. Vive en el VPS detrás de Nginx (sitio "bugs-manager").
 *
 *   node bugs-hub.mjs serve
 *   node bugs-hub.mjs add-dev --email a@b.com --name "Ana" --mode inbox
 *   node bugs-hub.mjs add-dev --email a@b.com --name "Ana" --mode webhook --webhook-url https://ana.example.com/bugs
 *   node bugs-hub.mjs add-dev --email a@b.com --name "Ana" --mode webhook --pubkey "ssh-ed25519 AAAA…" --webhook-path /bugs
 *   node bugs-hub.mjs add-dev --email a@b.com --name "Ana" --mode bugs-manager --pubkey "ssh-ed25519 AAAA…"
 *   node bugs-hub.mjs add-dev --email a@b.com --name "Ana" --mode bugs-manager --port 9077
 *   node bugs-hub.mjs remove-dev --email a@b.com
 *   node bugs-hub.mjs add-client --name qa-agent [--token <existente>]
 *   node bugs-hub.mjs list
 *
 * Archivos (BUGS_HUB_DIR, por defecto /var/lib/bugs-hub; todos 600):
 *   clients.json   agentes que piden fixes (nombre + token)
 *   devs.json      desarrolladores: email, nombre, modo, destino y token (también firma los webhooks)
 *   requests.json  peticiones de los modos webhook/inbox, con su estado
 *   jobs.jsonl     job_id → email de las peticiones reenviadas a un bugs-manager
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const DIR = process.env.BUGS_HUB_DIR ?? '/var/lib/bugs-hub';
const PORT = Number(process.env.BUGS_HUB_PORT ?? 9070);
const PUBLIC_URL = (process.env.BUGS_HUB_PUBLIC_URL ?? 'https://89-117-56-211.sslip.io').replace(/\/+$/, '');
const JIRA_BASE_URL = (process.env.BUGS_HUB_JIRA_BASE_URL ?? 'https://qrveydev.atlassian.net').replace(/\/+$/, '');
const ALLOWED_PROJECTS = (process.env.BUGS_HUB_ALLOWED_PROJECTS ?? 'AN').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const AUTHORIZED_KEYS = process.env.BUGS_HUB_AUTHORIZED_KEYS ?? '/root/.ssh/authorized_keys';
const RATE_LIMIT_PER_HOUR = Number(process.env.BUGS_HUB_RATE_LIMIT ?? 60);
const FIRST_TUNNEL_PORT = 9077;
const UPSTREAM_TIMEOUT_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
/** Reintentos del webhook (minutos tras cada fallo). Después queda solo en la bandeja. */
const WEBHOOK_BACKOFF_MIN = [1, 5, 15, 30, 60, 120, 240, 480, 720];
/** Latido del stream: mantiene viva la conexión a través de proxies y deja detectar cortes. */
const STREAM_HEARTBEAT_MS = 25_000;
const STREAM_MAX_PER_DEV = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TICKET_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const MODES = ['webhook', 'inbox', 'bugs-manager'];
const DEV_STATUSES = ['acknowledged', 'in_progress', 'fixed', 'already_fixed', 'cannot_fix', 'discarded'];
const FINAL = new Set(['fixed', 'already_fixed', 'cannot_fix', 'discarded']);
const STATUS_LABELS = {
  pending: 'Pendiente de entrega',
  delivered: 'Entregado al desarrollador',
  acknowledged: 'Recibido por el desarrollador',
  in_progress: 'En curso',
  fixed: 'Solucionado',
  already_fixed: 'Ya estaba solucionado',
  cannot_fix: 'No se puede solucionar',
  discarded: 'Descartado',
};

const file = (name) => path.join(DIR, name);
const readJson = (name, fallback) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : fallback);
const writeJson = (name, value) => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file(name)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file(name));
};
const newToken = () => randomBytes(32).toString('hex');
const normEmail = (s) => String(s ?? '').trim().toLowerCase();
const now = () => new Date().toISOString();
/** Entradas antiguas sin modo: si tienen upstream, eran bugs-manager. */
const modeOf = (dev) => dev.mode ?? (dev.upstream ? 'bugs-manager' : 'inbox');

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

function serve() {
  const jobs = new Map();
  if (existsSync(file('jobs.jsonl'))) {
    for (const line of readFileSync(file('jobs.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        jobs.set(j.job_id, j.email);
      } catch {}
    }
  }
  /** Peticiones de webhook/inbox. Un solo proceso: el mapa en memoria es la fuente y se vuelca a disco en cada cambio. */
  const requests = new Map(readJson('requests.json', []).map((r) => [r.id, r]));
  const saveRequests = () => writeJson('requests.json', [...requests.values()]);
  const hits = new Map();
  /** Conexiones SSE abiertas por email de desarrollador. */
  const streams = new Map();

  function sse(res, event, data, id) {
    res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Envía el aviso a todas las conexiones del dev. Devuelve true si había alguna. */
  function pushToStreams(r, dev) {
    const set = streams.get(dev.email);
    if (!set?.size) return false;
    const event = eventOf(r, dev);
    for (const res of set) sse(res, 'fix_requested', event, r.id);
    return true;
  }

  setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
  }, STREAM_HEARTBEAT_MS).unref();

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let caller = '-';
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(body));
      log({ method: req.method, path: req.url, status, caller, ms: Date.now() - started });
    };
    const fail = (status, code, message, extra = {}) => send(status, { error: { code, message, ...extra } });

    try {
      const url = new URL(req.url ?? '/', 'http://hub');
      const route = url.pathname.replace(/\/+$/, '');
      if (!route.startsWith('/external/v1/')) return fail(404, 'not_found', 'Ruta no encontrada');

      // Se leen en cada petición: add-dev / remove-dev surten efecto sin reiniciar.
      const clients = readJson('clients.json', []);
      const devs = readJson('devs.json', []);

      // Quién llama: un agente (cliente) o un desarrollador (con su propio token).
      const [scheme, value] = (req.headers.authorization ?? '').split(' ');
      const given = scheme === 'Bearer' && value ? Buffer.from(value) : undefined;
      const same = (t) => given && Buffer.from(t).length === given.length && timingSafeEqual(Buffer.from(t), given);
      const client = clients.find((c) => same(c.token));
      const devCaller = !client && devs.find((d) => same(d.token));
      if (!client && !devCaller) return fail(401, 'unauthorized', 'Falta o es inválida la cabecera Authorization: Bearer <token>');
      caller = client ? client.name : `dev:${devCaller.email}`;

      // ---- Rutas del desarrollador --------------------------------------------
      if (devCaller) {
        // Stream (SSE): al conectar recibe lo pendiente y después los avisos en vivo.
        if (req.method === 'GET' && route === '/external/v1/stream') {
          if (modeOf(devCaller) === 'bugs-manager') return fail(409, 'mode_not_supported', 'Tus avisos llegan a tu bugs-manager; el stream es para los modos bandeja y webhook');
          const set = streams.get(devCaller.email) ?? new Set();
          if (set.size >= STREAM_MAX_PER_DEV) return fail(429, 'too_many_streams', `Máximo ${STREAM_MAX_PER_DEV} conexiones abiertas a la vez`);
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write('retry: 5000\n\n');
          sse(res, 'ready', { email: devCaller.email, name: devCaller.name, connected_at: now() });
          const pending = [...requests.values()]
            .filter((r) => r.email === devCaller.email && (r.status === 'pending' || r.status === 'delivered'))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          let changed = false;
          for (const r of pending) {
            sse(res, 'fix_requested', eventOf(r, devCaller), r.id);
            if (r.status === 'pending') {
              r.status = 'delivered';
              r.updated_at = now();
              r.history.push({ status: 'delivered', message: 'entregado por stream', at: r.updated_at });
              changed = true;
            }
          }
          if (changed) saveRequests();
          set.add(res);
          streams.set(devCaller.email, set);
          log({ msg: 'stream abierto', dev: devCaller.email, pending: pending.length, open: set.size });
          req.on('close', () => {
            set.delete(res);
            if (!set.size) streams.delete(devCaller.email);
            log({ msg: 'stream cerrado', dev: devCaller.email, open: set.size });
          });
          return;
        }

        if (req.method === 'GET' && route === '/external/v1/inbox') {
          const all = url.searchParams.get('all') === '1';
          const items = [...requests.values()]
            .filter((r) => r.email === devCaller.email && (all || r.status === 'pending' || r.status === 'delivered'))
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map((r) => eventOf(r, devCaller));
          return send(200, { items });
        }
        const sm = route.match(/^\/external\/v1\/fix-requests\/([A-Za-z0-9-]{1,64})\/status$/);
        if (req.method === 'POST' && sm) {
          const r = requests.get(sm[1]);
          if (!r || r.email !== devCaller.email) return fail(404, 'not_found', 'Petición no encontrada');
          let body;
          try {
            body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
          } catch {
            return fail(400, 'invalid_request', 'El cuerpo no es JSON válido');
          }
          const problems = validateStatus(body);
          if (problems.length) return fail(400, 'invalid_request', 'El cuerpo no cumple el contrato', { details: problems });
          if (FINAL.has(r.status) && r.status !== body.status) return fail(409, 'already_finished', `La petición ya terminó (${r.status})`);
          r.status = body.status;
          r.message = body.message ?? r.message ?? null;
          if (body.result) r.result = { ...(r.result ?? {}), ...body.result };
          r.updated_at = now();
          if (FINAL.has(r.status)) r.finished_at = r.finished_at ?? r.updated_at;
          r.history.push({ status: r.status, message: body.message ?? null, at: r.updated_at });
          saveRequests();
          return send(200, viewOf(r, devCaller));
        }
        const gm = route.match(/^\/external\/v1\/fix-requests\/([A-Za-z0-9-]{1,64})$/);
        if (req.method === 'GET' && gm) {
          const r = requests.get(gm[1]);
          if (!r || r.email !== devCaller.email) return fail(404, 'not_found', 'Petición no encontrada');
          return send(200, viewOf(r, devCaller));
        }
        return fail(404, 'not_found', 'Ruta no disponible para desarrolladores');
      }

      // ---- Rutas del agente (QA) ------------------------------------------------
      if (req.method === 'GET' && route === '/external/v1/assignees') {
        return send(200, { assignees: devs.map((d) => ({ email: d.email, name: d.name })) });
      }

      if (req.method === 'POST' && route === '/external/v1/fix-requests') {
        if (!allow(hits, client.name)) return fail(429, 'rate_limited', `Máximo ${RATE_LIMIT_PER_HOUR} peticiones por hora`);
        let body;
        try {
          body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
        } catch (err) {
          return fail(err.code === 'too_large' ? 413 : 400, 'invalid_request', err.code === 'too_large' ? 'Cuerpo demasiado grande' : 'El cuerpo no es JSON válido');
        }
        const problems = validateFixRequest(body);
        if (problems.length) return fail(400, 'invalid_request', 'El cuerpo no cumple el contrato', { details: problems });
        const ticket = body.ticket.trim().toUpperCase();
        const project = ticket.split('-')[0];
        if (ALLOWED_PROJECTS.length && !ALLOWED_PROJECTS.includes(project)) {
          return fail(422, 'project_not_allowed', `El proyecto ${project} no está habilitado para peticiones externas`);
        }
        const email = normEmail(body.assignee_email);
        const dev = devs.find((d) => d.email === email);
        if (!dev) return fail(422, 'assignee_not_registered', `${email} no está registrado. Consulta GET /external/v1/assignees`);
        const { assignee_email: _drop, ...forward } = body;
        forward.ticket = ticket;
        if (!forward.requested_by) forward.requested_by = client.name;

        if (modeOf(dev) === 'bugs-manager') {
          const up = await upstream(dev, 'POST', '/external/v1/fix-requests', forward);
          if (!up) return fail(502, 'assignee_unavailable', `El sistema de ${dev.name} no está disponible ahora. Reintenta más tarde.`);
          if ((up.status === 200 || up.status === 202) && up.body?.job_id && !jobs.has(up.body.job_id)) {
            jobs.set(up.body.job_id, dev.email);
            mkdirSync(DIR, { recursive: true, mode: 0o700 });
            appendFileSync(file('jobs.jsonl'), `${JSON.stringify({ job_id: up.body.job_id, email: dev.email, ticket: up.body.ticket, at: now() })}\n`, { mode: 0o600 });
          }
          return send(up.status, withAssignee(up.body, dev), up.retryAfter ? { 'retry-after': up.retryAfter } : {});
        }

        // webhook / inbox: el hub guarda la petición. Una activa por ticket y dev.
        const active = [...requests.values()].find((r) => r.email === dev.email && r.ticket === ticket && !FINAL.has(r.status));
        if (active) return send(200, { created: false, ...viewOf(active, dev) });
        const r = {
          id: randomUUID(),
          email: dev.email,
          ticket,
          requested_by: String(forward.requested_by),
          reason: forward.reason ?? null,
          source_branch: forward.source_branch ?? null,
          status: 'pending',
          message: null,
          result: null,
          created_at: now(),
          updated_at: now(),
          finished_at: null,
          delivery: { attempts: 0, next_at: modeOf(dev) === 'webhook' ? now() : null, last_error: null, delivered_at: null },
          history: [{ status: 'pending', message: null, at: now() }],
        };
        requests.set(r.id, r);
        saveRequests();
        if (pushToStreams(r, dev)) {
          r.status = 'delivered';
          r.history.push({ status: 'delivered', message: 'entregado por stream', at: now() });
          saveRequests();
        }
        if (modeOf(dev) === 'webhook') await deliver(r, dev);
        return send(202, { created: true, ...viewOf(r, dev) });
      }

      const m = route.match(/^\/external\/v1\/fix-requests\/([A-Za-z0-9-]{1,64})$/);
      if (req.method === 'GET' && m) {
        const r = requests.get(m[1]);
        if (r) {
          const dev = devs.find((d) => d.email === r.email) ?? { email: r.email, name: r.email };
          return send(200, viewOf(r, dev));
        }
        const email = jobs.get(m[1]);
        const dev = email && devs.find((d) => d.email === email);
        if (!dev) return fail(404, 'not_found', 'Petición no encontrada');
        const up = await upstream(dev, 'GET', `/external/v1/fix-requests/${m[1]}`);
        if (!up) return fail(502, 'assignee_unavailable', `El sistema de ${dev.name} no está disponible ahora. Reintenta más tarde.`);
        return send(up.status, withAssignee(up.body, dev));
      }

      return fail(404, 'not_found', 'Ruta no encontrada');
    } catch (err) {
      log({ level: 'error', err: err.message });
      if (!res.headersSent) fail(500, 'internal_error', 'Error interno del hub');
    }
  });

  /** Entrega por webhook. Éxito = 2xx. En fallo programa el siguiente intento; la petición sigue en la bandeja. */
  async function deliver(r, dev) {
    const event = eventOf(r, dev);
    const raw = JSON.stringify(event);
    const signature = `sha256=${createHmac('sha256', dev.token).update(raw).digest('hex')}`;
    r.delivery.attempts += 1;
    try {
      const res = await fetch(dev.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'bugs-hub/1',
          'x-bugs-hub-event': event.event,
          'x-bugs-hub-delivery': r.id,
          'x-bugs-hub-signature-256': signature,
        },
        body: raw,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (r.status === 'pending') {
        r.status = 'delivered';
        r.history.push({ status: 'delivered', message: null, at: now() });
      }
      r.delivery.delivered_at = now();
      r.delivery.next_at = null;
      r.delivery.last_error = null;
      log({ msg: 'webhook entregado', id: r.id, dev: dev.email, attempts: r.delivery.attempts });
    } catch (err) {
      const wait = WEBHOOK_BACKOFF_MIN[r.delivery.attempts - 1];
      r.delivery.last_error = err.message;
      r.delivery.next_at = wait ? new Date(Date.now() + wait * 60_000).toISOString() : null;
      log({ level: 'warn', msg: 'webhook fallido', id: r.id, dev: dev.email, attempts: r.delivery.attempts, err: err.message, next_at: r.delivery.next_at });
    }
    r.updated_at = now();
    saveRequests();
  }

  // Reintentos pendientes de webhook.
  setInterval(async () => {
    const devs = readJson('devs.json', []);
    for (const r of requests.values()) {
      if (r.status !== 'pending' || !r.delivery?.next_at || r.delivery.next_at > now()) continue;
      const dev = devs.find((d) => d.email === r.email);
      if (dev && modeOf(dev) === 'webhook') await deliver(r, dev);
    }
  }, 30_000).unref();

  server.listen(PORT, '127.0.0.1', () => log({ msg: `bugs-hub escuchando en 127.0.0.1:${PORT}`, dir: DIR }));

  function allow(map, who) {
    const t = Date.now();
    const recent = (map.get(who) ?? []).filter((x) => t - x < 3_600_000);
    const ok = recent.length < RATE_LIMIT_PER_HOUR;
    if (ok) recent.push(t);
    map.set(who, recent);
    return ok;
  }
}

/** Evento que recibe el desarrollador (webhook y bandeja): mismo formato. */
function eventOf(r, dev) {
  return {
    event: 'fix_requested',
    id: r.id,
    ticket: r.ticket,
    ticket_url: `${JIRA_BASE_URL}/browse/${r.ticket}`,
    assignee: { email: dev.email, name: dev.name },
    requested_by: r.requested_by,
    reason: r.reason,
    source_branch: r.source_branch,
    status: r.status,
    created_at: r.created_at,
    status_url: `${PUBLIC_URL}/external/v1/fix-requests/${r.id}/status`,
  };
}

/** Vista de la petición para QA: mismo formato que devuelve bugs-manager. */
function viewOf(r, dev) {
  const state = FINAL.has(r.status) ? 'finished' : r.status === 'pending' || r.status === 'delivered' ? 'waiting_for_human' : 'in_progress';
  return {
    job_id: r.id,
    ticket: r.ticket,
    ticket_url: `${JIRA_BASE_URL}/browse/${r.ticket}`,
    assignee: { email: dev.email, name: dev.name },
    status: r.status,
    status_label: STATUS_LABELS[r.status] ?? r.status,
    state,
    pending_question: null,
    dev_message: r.message ?? null,
    requested_by: r.requested_by,
    source_branch: r.source_branch,
    slack_thread_url: null,
    dashboard_url: null,
    result: FINAL.has(r.status)
      ? {
          kind: r.status,
          already_fixed_by: r.result?.already_fixed_by ?? null,
          issue: r.result?.issue ?? null,
          solution: r.result?.solution ?? null,
          notes_for_qa: r.result?.notes_for_qa ?? null,
          reproduction: r.result?.reproduction ?? null,
          reason: r.result?.reason ?? null,
        }
      : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    finished_at: r.finished_at,
  };
}

function validateFixRequest(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['body: debe ser un objeto JSON'];
  const p = [];
  const allowed = new Set(['ticket', 'assignee_email', 'requested_by', 'reason', 'source_branch']);
  for (const k of Object.keys(b)) if (!allowed.has(k)) p.push(`body: Unrecognized key: "${k}"`);
  if (typeof b.ticket !== 'string' || !TICKET_RE.test(b.ticket.trim().toUpperCase())) p.push('ticket: formato esperado: PROYECTO-123');
  if (!EMAIL_RE.test(normEmail(b.assignee_email))) p.push('assignee_email: obligatorio, email del desarrollador que debe resolverlo');
  if (b.requested_by !== undefined && (typeof b.requested_by !== 'string' || !b.requested_by.trim() || b.requested_by.length > 100)) p.push('requested_by: texto de 1 a 100 caracteres');
  if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 4000)) p.push('reason: texto de hasta 4000 caracteres');
  if (b.source_branch !== undefined && (typeof b.source_branch !== 'string' || !BRANCH_RE.test(b.source_branch.trim()))) p.push('source_branch: nombre de rama inválido');
  return p;
}

function validateStatus(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['body: debe ser un objeto JSON'];
  const p = [];
  if (!DEV_STATUSES.includes(b.status)) p.push(`status: uno de ${DEV_STATUSES.join(', ')}`);
  if (b.message !== undefined && (typeof b.message !== 'string' || b.message.length > 2000)) p.push('message: texto de hasta 2000 caracteres');
  if (b.result !== undefined) {
    if (!b.result || typeof b.result !== 'object' || Array.isArray(b.result)) p.push('result: debe ser un objeto');
    else {
      const keys = ['issue', 'solution', 'notes_for_qa', 'already_fixed_by', 'reason', 'reproduction'];
      for (const [k, v] of Object.entries(b.result)) {
        if (!keys.includes(k)) p.push(`result.${k}: campo no admitido (${keys.join(', ')})`);
        else if (typeof v !== 'string' || v.length > 4000) p.push(`result.${k}: texto de hasta 4000 caracteres`);
      }
    }
  }
  return p;
}

function withAssignee(body, dev) {
  return body && typeof body === 'object' && !Array.isArray(body) ? { ...body, assignee: { email: dev.email, name: dev.name } } : body;
}

/** Llama al bugs-manager del dev. undefined = no responde (túnel caído, servicio apagado, timeout). */
async function upstream(dev, method, pathname, body) {
  try {
    const res = await fetch(new URL(pathname, dev.upstream), {
      method,
      headers: { authorization: `Bearer ${dev.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 502 || res.status === 503 || res.status === 504) return undefined;
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { code: 'upstream_error', message: `Respuesta no JSON (${res.status})` } };
    }
    if (res.status === 401) return { status: 502, body: { error: { code: 'assignee_misconfigured', message: `El sistema de ${dev.name} rechazó al hub (token). Avisa al administrador.` } } };
    return { status: res.status, body: parsed, retryAfter: res.headers.get('retry-after') };
  } catch {
    return undefined;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(obj) {
  console.log(JSON.stringify({ t: now(), ...obj }));
}

// ---------------------------------------------------------------------------
// CLI de administración
// ---------------------------------------------------------------------------

function args() {
  const out = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return out;
}

/** Autoriza la clave del túnel del dev, restringida a su puerto y sin shell. Devuelve el puerto. */
function authorizeTunnel(pubkey, email, devs, wanted) {
  const key = String(pubkey).trim();
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+/.test(key)) {
    console.error('La clave pública no parece válida (esperado "ssh-ed25519 AAAA… comentario")');
    process.exit(1);
  }
  const used = new Set(devs.filter((d) => d.email !== email).map((d) => d.port).filter(Boolean));
  let port = wanted;
  if (!port) for (port = FIRST_TUNNEL_PORT; used.has(port); port++);
  const keyBody = key.split(/\s+/).slice(0, 2).join(' ');
  const current = existsSync(AUTHORIZED_KEYS) ? readFileSync(AUTHORIZED_KEYS, 'utf8') : '';
  if (!current.includes(keyBody)) {
    if (existsSync(AUTHORIZED_KEYS)) copyFileSync(AUTHORIZED_KEYS, `${AUTHORIZED_KEYS}.bak-bugs-hub-${Date.now()}`);
    const line = `restrict,port-forwarding,permitlisten="127.0.0.1:${port}",command="/usr/sbin/nologin" ${keyBody} bugs-hub:${email}\n`;
    appendFileSync(AUTHORIZED_KEYS, (current && !current.endsWith('\n') ? '\n' : '') + line);
  }
  return port;
}

function addDev() {
  const a = args();
  const email = normEmail(a.email);
  const mode = a.mode ?? (a['webhook-url'] || a['webhook-path'] ? 'webhook' : a.upstream || a.port ? 'bugs-manager' : 'inbox');
  const usage =
    'Uso: add-dev --email <email> --name "<nombre>" --mode inbox\n' +
    '     add-dev --email <email> --name "<nombre>" --mode webhook (--webhook-url https://… | --pubkey "<clave>" --webhook-path /ruta)\n' +
    '     add-dev --email <email> --name "<nombre>" --mode bugs-manager (--pubkey "<clave>" | --port <puerto> | --upstream https://…)';
  if (!EMAIL_RE.test(email) || !a.name || !MODES.includes(mode)) {
    console.error(usage);
    process.exit(1);
  }
  const devs = readJson('devs.json', []);
  const existing = devs.find((d) => d.email === email);
  const dev = { email, name: String(a.name), mode, token: existing?.token ?? newToken(), createdAt: existing?.createdAt ?? now() };

  if (a.pubkey) dev.port = authorizeTunnel(a.pubkey, email, devs, a.port ? Number(a.port) : existing?.port);
  else if (a.port) dev.port = Number(a.port);

  if (mode === 'webhook') {
    if (a['webhook-url']) dev.webhook_url = String(a['webhook-url']);
    else if (dev.port && a['webhook-path']) dev.webhook_url = `http://127.0.0.1:${dev.port}${String(a['webhook-path']).startsWith('/') ? '' : '/'}${a['webhook-path']}`;
    else {
      console.error(usage);
      process.exit(1);
    }
  }
  if (mode === 'bugs-manager') {
    dev.upstream = a.upstream ? String(a.upstream) : dev.port ? `http://127.0.0.1:${dev.port}` : undefined;
    if (!dev.upstream) {
      console.error(usage);
      process.exit(1);
    }
  }
  writeJson('devs.json', [...devs.filter((d) => d.email !== email), dev]);

  console.log(`Registrado ${dev.name} <${email}> · modo ${mode}${dev.webhook_url ? ` → ${dev.webhook_url}` : dev.upstream ? ` → ${dev.upstream}` : ''}`);
  console.log('');
  console.log('Pásale al desarrollador (por canal privado):');
  console.log(`  Token: ${dev.token}`);
  if (dev.port) console.log(`  Puerto del túnel: ${dev.port}`);
  if (mode === 'webhook') console.log('  (el mismo token firma los webhooks: cabecera X-Bugs-Hub-Signature-256)');
  if (mode === 'bugs-manager') console.log(`  Línea para su .env: EXTERNAL_API_TOKENS=qa-hub:${dev.token}`);
}

function removeDev() {
  const email = normEmail(args().email);
  const devs = readJson('devs.json', []);
  const dev = devs.find((d) => d.email === email);
  if (!dev) {
    console.error(`${email} no está registrado`);
    process.exit(1);
  }
  writeJson('devs.json', devs.filter((d) => d.email !== email));
  if (existsSync(AUTHORIZED_KEYS)) {
    const lines = readFileSync(AUTHORIZED_KEYS, 'utf8').split('\n');
    const kept = lines.filter((l) => !l.endsWith(` bugs-hub:${email}`));
    if (kept.length !== lines.length) {
      copyFileSync(AUTHORIZED_KEYS, `${AUTHORIZED_KEYS}.bak-bugs-hub-${Date.now()}`);
      writeFileSync(AUTHORIZED_KEYS, kept.join('\n'));
    }
  }
  console.log(`Eliminado ${dev.name} <${email}> (y su clave del túnel, si la tenía)`);
}

function addClient() {
  const a = args();
  if (!a.name) {
    console.error('Uso: add-client --name <nombre> [--token <token existente de 32+ caracteres>]');
    process.exit(1);
  }
  const token = typeof a.token === 'string' && a.token.length >= 32 ? a.token : newToken();
  const clients = readJson('clients.json', []);
  writeJson('clients.json', [...clients.filter((c) => c.name !== a.name), { name: a.name, token, createdAt: now() }]);
  console.log(`Cliente ${a.name} registrado. Token (entregar por canal privado): ${token}`);
}

function list() {
  const clients = readJson('clients.json', []);
  const devs = readJson('devs.json', []);
  console.log('Clientes (agentes):', clients.map((c) => c.name).join(', ') || '(ninguno)');
  console.log('Desarrolladores:');
  for (const d of devs) console.log(`  ${d.email.padEnd(32)} ${d.name.padEnd(20)} ${modeOf(d).padEnd(13)} ${d.webhook_url ?? d.upstream ?? '(bandeja)'}`);
}

const cmd = process.argv[2];
const commands = { serve, 'add-dev': addDev, 'remove-dev': removeDev, 'add-client': addClient, list };
if (!commands[cmd]) {
  console.error(`Comandos: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
commands[cmd]();
