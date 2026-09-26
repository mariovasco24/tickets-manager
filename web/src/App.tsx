import { useEffect, useMemo, useState } from 'react';
import { JOB_STATUSES, STATUS_LABELS, isAwaiting, type JobStatus, type MetaDto } from '../../src/shared/job-types';
import { api } from './api';
import { JobDetail } from './components/JobDetail';
import { JobRow } from './components/JobRow';
import { useJobs } from './useJobs';

type Filter = JobStatus | 'all' | 'active' | 'awaiting';

export function App() {
  const { jobs, mode, error, refresh } = useJobs();
  const [meta, setMeta] = useState<MetaDto | null>(null);
  // ?job=<id> (enlace desde Slack) abre ese job expandido.
  const linkedJob = new URLSearchParams(window.location.search).get('job');
  // Por defecto solo los activos: lo terminado es historial. Con enlace a un job concreto se muestra
  // todo, porque ese job puede estar ya terminado y el filtro lo ocultaría.
  const [filter, setFilter] = useState<Filter>(linkedJob ? 'all' : 'active');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(linkedJob);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<string | null>(null);

  const cleanup = async () => {
    if (!window.confirm('Eliminar del disco los worktrees de todos los jobs terminados (solucionado, no se pudo, fallido, descartado)?')) return;
    try {
      const r = await api.cleanupWorktrees();
      const errs = r.errors.length ? ` Errores: ${r.errors.map((e) => `${e.ticketKey}: ${e.error}`).join('; ')}` : '';
      setNotice(`Worktrees eliminados: ${r.removed.length}${r.removed.length ? ` (${r.removed.join(', ')})` : ''}.${errs}`);
    } catch (err) {
      setNotice(`Error limpiando worktrees: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    api.meta().then(setMeta).catch(() => setMeta(null));
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const counts = useMemo(() => {
    const c: Partial<Record<JobStatus, number>> = {};
    for (const j of jobs) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [jobs]);
  const awaitingCount = jobs.filter((j) => isAwaiting(j.status)).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (filter === 'active' && ['fixed', 'cannot_fix', 'failed', 'discarded'].includes(j.status)) return false;
      if (filter === 'awaiting' && !isAwaiting(j.status)) return false;
      if (filter !== 'all' && filter !== 'active' && filter !== 'awaiting' && j.status !== filter) return false;
      if (q && !j.ticketKey.toLowerCase().includes(q) && !(j.ticketSummary ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [jobs, filter, query]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Bugs Manager
        </h1>
        <div className="topbar-right">
          {awaitingCount > 0 && (
            <button type="button" className="pill pill-warn" onClick={() => setFilter('awaiting')}>
              {awaitingCount} esperando respuesta
            </button>
          )}
          <span className={`live live-${mode}`} title="Modo de actualización">
            {mode === 'sse' ? '● en vivo' : mode === 'polling' ? '◌ polling 5s' : '… conectando'}
          </span>
          <button type="button" className="btn btn-small" onClick={() => void refresh()}>
            Recargar
          </button>
          <button type="button" className="btn btn-small" onClick={() => void cleanup()} title="Elimina del disco los worktrees de jobs terminados">
            Limpiar worktrees cerrados
          </button>
        </div>
      </header>
      {notice && (
        <p className="notice" onClick={() => setNotice(null)}>
          {notice}
        </p>
      )}

      <div className="toolbar">
        <input
          type="search"
          placeholder="Buscar por clave o título (AN-1234)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="search"
        />
        <div className="filters">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`Todos (${jobs.length})`} />
          <FilterChip
            active={filter === 'active'}
            onClick={() => setFilter('active')}
            label={`Activos (${jobs.length - (counts.fixed ?? 0) - (counts.cannot_fix ?? 0) - (counts.failed ?? 0) - (counts.discarded ?? 0)})`}
          />
          {JOB_STATUSES.map((s) => (
            <FilterChip
              key={s}
              active={filter === s}
              onClick={() => setFilter(s)}
              label={`${STATUS_LABELS[s]} (${counts[s] ?? 0})`}
              status={s}
            />
          ))}
        </div>
      </div>

      {error && <p className="error">Error cargando jobs: {error}</p>}

      <main className="list">
        <div className="row row-head">
          <span className="chev" />
          <span className="col-key">Ticket</span>
          <span className="col-title">Título</span>
          <span className="col-status">Estado</span>
          <span className="col-branches">Origen → creada</span>
          <span className="col-origin">Disparo</span>
          <span className="col-time">Creado / actividad</span>
        </div>
        {visible.length === 0 && (
          <p className="empty">
            {jobs.length === 0
              ? 'Aún no hay jobs. Escribe en Slack "@bugsmanager revisa el ticket AN-1234" o usa /fix.'
              : 'Ningún job coincide con el filtro.'}
          </p>
        )}
        {visible.map((job) => (
          <div key={job.id}>
            <JobRow
              job={job}
              now={now}
              expanded={expanded === job.id}
              onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
            />
            {expanded === job.id && (
              <JobDetail job={job} devMode={meta?.devMode ?? false} prEnabled={meta?.prEnabled ?? false} jiraMergeStatus={meta?.jiraMergeStatus ?? null} />
            )}
          </div>
        ))}
      </main>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  status,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  status?: JobStatus;
}) {
  return (
    <button type="button" className={`chip ${active ? 'chip-active' : ''} ${status ? `status-${status}` : ''}`} onClick={onClick}>
      {label}
    </button>
  );
}
