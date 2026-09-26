import { useEffect, useState, type FormEvent } from 'react';
import {
  JOB_STATUSES,
  STATUS_LABELS,
  isAwaiting,
  isTerminal,
  type JobDetailDto,
  type JobDto,
  type JobStatus,
} from '../../../src/shared/job-types';
import { api } from '../api';
import { formatDate } from '../format';
import { ClaudeSession } from './ClaudeSession';
import { CopyButton } from './CopyButton';

interface Props {
  job: JobDto;
  devMode: boolean;
  /** El servicio ofrece subir la rama y abrir el PR (PR_ENABLED). */
  prEnabled: boolean;
  /** Estado de Jira que se ofrece tras el PR; null = no se ofrece. */
  jiraMergeStatus: string | null;
}

export function JobDetail({ job, devMode, prEnabled, jiraMergeStatus }: Props) {
  const [detail, setDetail] = useState<JobDetailDto | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);

  // Ramas del remoto para el desplegable cuando se espera la rama origen.
  useEffect(() => {
    if (job.status !== 'awaiting_branch') return;
    api
      .branches()
      .then(setBranches)
      .catch(() => setBranches([]));
  }, [job.status]);

  // Recarga la bitácora cada vez que el job cambia (llega por SSE).
  useEffect(() => {
    let cancelled = false;
    api
      .job(job.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [job.id, job.updatedAt]);

  const submitAnswer = async (e: FormEvent) => {
    e.preventDefault();
    if (!answer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.answer(job.id, answer.trim());
      setAnswer('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Confirmación de repositorios (awaiting_repos)
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [extraRepo, setExtraRepo] = useState('');
  const [allRepos, setAllRepos] = useState<Array<{ name: string; cloned: boolean }>>([]);
  const repoStatus = Object.fromEntries(allRepos.map((r) => [r.name, r])) as Record<string, { cloned: boolean }>;
  useEffect(() => {
    if (job.status !== 'awaiting_repos') return;
    setSelectedRepos(job.triageResult?.repos.map((r) => r.name) ?? []);
    api
      .repos()
      .then(setAllRepos)
      .catch(() => setAllRepos([]));
  }, [job.status, job.updatedAt, job.triageResult]);
  const addExtraRepo = () => {
    const name = extraRepo.trim();
    if (!name) return;
    setSelectedRepos((s) => (s.includes(name) ? s : [...s, name]));
    setExtraRepo('');
  };
  const confirmRepos = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.confirmRepos(job.id, selectedRepos);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const rejectRepos = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.rejectRepos(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const publishToJira = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.jiraComment(job.id, 'publish');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const jiraDecision = async (action: 'transition' | 'skip') => {
    setBusy(true);
    setError(null);
    try {
      await api.jiraDecision(job.id, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const regressionDecision = async (action: 'accept' | 'discard') => {
    if (action === 'discard' && !window.confirm(`Descartar el job de ${job.ticketKey} por falta de spec de regresión?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.regressionDecision(job.id, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pullRequestDecision = async (action: 'open' | 'skip') => {
    if (action === 'open' && !window.confirm(`Commitear los cambios del worktree, subir la rama ${job.branch ?? ''} y abrir el PR hacia ${job.sourceBranch ?? ''}?\n\nNunca se empuja a la rama origen ni se mergea: el PR queda abierto.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.pullRequest(job.id, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const jiraMerge = async (action: 'transition' | 'skip') => {
    setBusy(true);
    setError(null);
    try {
      await api.jiraMerge(job.id, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Cierre del ciclo: PR → estado en Jira → comentario. Cada paso se ofrece una sola vez.
  const events = detail?.events ?? [];
  const prWorktrees = (detail?.worktrees ?? []).filter((w) => w.prUrl && !w.removedAt);
  const prOpened = prWorktrees.length > 0;
  const prDecided = prOpened || events.some((e) => e.type === 'pr_opened' || e.type === 'pr_skipped');
  const mergeDecided = events.some((e) => e.type.startsWith('jira_merge_'));

  const envDecision = async (action: 'code_only' | 'discard' | 'retry') => {
    setBusy(true);
    setError(null);
    try {
      await api.envDecision(job.id, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const [message, setMessage] = useState('');
  const submitMessage = async (e: FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.message(job.id, message.trim());
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeWorktree = async () => {
    if (!window.confirm(`Eliminar del disco el worktree de ${job.ticketKey}?\n${job.worktreePath}\n\nLos cambios no commiteados se perderán.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeWorktree(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    const reason = window.prompt(`Descartar ${job.ticketKey}. Motivo (opcional):`);
    if (reason === null) return;
    setBusy(true);
    try {
      await api.discard(job.id, reason || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail">
      {job.status === 'awaiting_repos' && (
        <section className="panel panel-pending">
          <h4>Confirmar repositorios</h4>
          <p className="pending-question">{job.pendingQuestion ?? '(sin texto)'}</p>
          {job.triageResult?.analysis && <pre className="prewrap triage-analysis">{job.triageResult.analysis}</pre>}
          <ul className="repo-list">
            {job.triageResult?.repos.map((r) => (
              <li key={r.name}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedRepos.includes(r.name)}
                    onChange={(e) => setSelectedRepos((s) => (e.target.checked ? [...s, r.name] : s.filter((x) => x !== r.name)))}
                  />
                  <strong className="mono">{r.name}</strong> <span className={`badge conf-${r.confidence}`}>{r.confidence}</span>
                  {!repoStatus[r.name]?.cloned && <span className="muted"> · se clonará</span>}
                </label>
                {r.reason && <div className="muted repo-reason">{r.reason}</div>}
              </li>
            ))}
          </ul>
          <div className="answer-form">
            <input
              list="all-repos"
              className="branch-input"
              value={extraRepo}
              onChange={(e) => setExtraRepo(e.target.value)}
              placeholder="Añadir otro repo del manifest…"
              disabled={busy}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addExtraRepo();
                }
              }}
            />
            <datalist id="all-repos">
              {allRepos.map((r) => (
                <option key={r.name} value={r.name} />
              ))}
            </datalist>
            <button type="button" className="btn" onClick={addExtraRepo} disabled={busy || !extraRepo.trim()}>
              Añadir
            </button>
          </div>
          {selectedRepos.some((r) => !job.triageResult?.repos.some((p) => p.name === r)) && (
            <p className="muted">Añadidos: {selectedRepos.filter((r) => !job.triageResult?.repos.some((p) => p.name === r)).map((r) => <code key={r}>{r} </code>)}</p>
          )}
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void confirmRepos()} disabled={busy || selectedRepos.length === 0}>
              Confirmar y crear worktrees ({selectedRepos.length})
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void rejectRepos()} disabled={busy}>
              Rechazar propuesta
            </button>
          </div>
          <p className="muted">También puedes confirmar con los botones del hilo de Slack o escribir allí <code>repos: a, b</code>.</p>
        </section>
      )}

      {job.status === 'awaiting_jira_status' && (
        <section className="panel panel-pending">
          <h4>Estado en Jira</h4>
          <p className="pending-question">{job.pendingQuestion ?? '(sin texto)'}</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void jiraDecision('transition')} disabled={busy}>
              Sí, cambiar estado
            </button>
            <button type="button" className="btn" onClick={() => void jiraDecision('skip')} disabled={busy}>
              No, dejarlo igual
            </button>
          </div>
          <p className="muted">Es el único cambio que el bot hace en Jira. Con "No" continúa sin tocar el ticket.</p>
        </section>
      )}

      {job.e2eMode === 'awaiting_env' && isAwaiting(job.status) && (
        <section className="panel panel-pending">
          <h4>Sin entorno de reproducción</h4>
          <p className="pending-question">{job.pendingQuestion ?? '(sin texto)'}</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void envDecision('code_only')} disabled={busy}>
              Corregir solo con código
            </button>
            <button type="button" className="btn" onClick={() => void envDecision('retry')} disabled={busy}>
              Reintentar entorno
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void envDecision('discard')} disabled={busy}>
              Descartar
            </button>
          </div>
          <p className="muted">
            Sin entorno no hay vídeo de antes y después: el fix se validará solo con los tests del repo. «Reintentar» vuelve a leer environments.json
            y a levantar el servidor, útil tras corregir la configuración o liberar el puerto.
          </p>
        </section>
      )}

      {job.status === 'awaiting_clarification' && job.regressionTest?.verdict === 'pending' && (
        <section className="panel panel-pending">
          <h4>Fix sin spec de regresión</h4>
          <p className="pending-question">{job.pendingQuestion ?? job.regressionTest.label}</p>
          {job.regressionTest.reason && <pre className="prewrap">{job.regressionTest.reason}</pre>}
          <div className="actions">
            <button type="button" className="btn" onClick={() => void regressionDecision('accept')} disabled={busy}>
              Aceptar sin spec
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void regressionDecision('discard')} disabled={busy}>
              Descartar
            </button>
          </div>
          <p className="muted">O escribe abajo indicaciones para Claude Code (dónde o cómo escribir el spec) y se reanudará la sesión.</p>
        </section>
      )}

      {isAwaiting(job.status) && job.status !== 'awaiting_repos' && job.status !== 'awaiting_jira_status' && job.e2eMode !== 'awaiting_env' && (
        <section className="panel panel-pending">
          <h4>Pregunta pendiente</h4>
          <p className="pending-question">{job.pendingQuestion ?? '(sin texto)'}</p>
          <form onSubmit={(e) => void submitAnswer(e)} className="answer-form">
            {job.status === 'awaiting_branch' ? (
              <>
                <input
                  list="remote-branches"
                  className="branch-input"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder={branches.length ? 'Elige o escribe la rama origen…' : 'Nombre de la rama origen, p. ej. develop'}
                  disabled={busy}
                  autoComplete="off"
                />
                <datalist id="remote-branches">
                  {branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </>
            ) : (
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Tu respuesta para Claude Code…"
                rows={3}
                disabled={busy}
              />
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || !answer.trim()}>
              {job.status === 'awaiting_branch' ? 'Crear worktree' : 'Responder'}
            </button>
          </form>
          <p className="muted">También puedes responder en el hilo de Slack; ambos caminos llegan al mismo sitio.</p>
        </section>
      )}

      <section className="grid">
        <Field label="Rama origen" value={job.sourceBranch} mono />
        <Field label="Rama creada" value={job.branch} mono copy />
        <Field label="Worktree" value={job.worktreePath} mono copy wide />
        <Field label="Solicitado por" value={job.requestedBy.replace(/^<@|>$/g, '')} />
        <Field label="Origen" value={job.source === 'webhook' ? 'Webhook de Jira' : 'Manual (Slack)'} />
        <Field label="Estado en Jira" value={job.ticketStatus} />
        <Field label="Creado" value={formatDate(job.createdAt)} />
        <Field label="Inicio del trabajo" value={formatDate(job.startedAt)} />
        <Field label="Finalizado" value={formatDate(job.finishedAt)} />
        <Field label="Sesión Claude Code" value={job.claudeSessionId} mono copy />
        <Field label="Reproduction" value={job.reproduction} wide={Boolean(job.reproduction && job.reproduction.length > 40)} />
        <Field label="Tests" value={job.testsResult ? `${testsLabel(job.testsResult)}${job.testsDetail ? ` — ${job.testsDetail}` : ''}` : null} wide={Boolean(job.testsDetail)} />
        <Field label="Regression test" value={job.regressionTest ? `${job.regressionTest.verdict === 'verified' ? '✅ ' : '⚠️ '}${job.regressionTest.label}` : null} wide />
        <Field
          label="Hilo de Slack"
          value={
            job.slackPermalink ? (
              <a href={job.slackPermalink} target="_blank" rel="noreferrer">
                Abrir hilo
              </a>
            ) : null
          }
        />
      </section>

      {detail && detail.worktrees.length > 0 && (
        <section className="panel">
          <h4>Worktrees ({detail.worktrees.filter((w) => !w.removedAt).length} activos)</h4>
          <ul className="worktree-list">
            {detail.worktrees.map((w) => (
              <li key={w.id} className={w.removedAt ? 'removed' : ''}>
                <strong className="mono">{w.repoName}</strong>
                {w.isPrimary && <span className="badge status-received">principal</span>}
                <span className="mono">{w.worktreePath}</span>
                {!w.removedAt && <CopyButton text={w.worktreePath} />}
                {w.prUrl && (
                  <a href={w.prUrl} target="_blank" rel="noreferrer">
                    PR #{w.prId} → {w.prDestination}
                  </a>
                )}
                {w.removedAt && <span className="muted">eliminado {formatDate(w.removedAt)}</span>}
                {w.installCommand && <span className="muted">· {w.installCommand}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {job.triageResult && job.status !== 'awaiting_repos' && (
        <section className="panel">
          <h4>Triaje</h4>
          <ul className="repo-list">
            {job.triageResult.repos.map((r) => (
              <li key={r.name}>
                <strong className="mono">{r.name}</strong> <span className={`badge conf-${r.confidence}`}>{r.confidence}</span>
                {r.reason && <span className="muted"> — {r.reason}</span>}
              </li>
            ))}
          </ul>
          {job.triageResult.analysis && <pre className="prewrap triage-analysis">{job.triageResult.analysis}</pre>}
        </section>
      )}

      {job.notes && (
        <section className="panel">
          <h4>Notas del equipo</h4>
          <pre className="prewrap">{job.notes}</pre>
        </section>
      )}

      {(job.issue || job.solution) && (
        <section className="panel report">
          <h4>Fix report</h4>
          <div className="report-block">
            <strong>Issue:</strong>
            <pre className="prewrap">{job.issue ?? '—'}</pre>
          </div>
          <div className="report-block">
            <strong>Solution:</strong>
            <pre className="prewrap">{job.solution ?? '—'}</pre>
          </div>
          {job.notesForQa && (
            <div className="report-block">
              <strong>Notes for QA:</strong>
              <pre className="prewrap">{job.notesForQa}</pre>
            </div>
          )}
          <div className="report-block">
            <strong>Branch:</strong> <span className="mono">{job.branch ?? '—'}</span>
            {job.branch && <CopyButton text={job.branch} />}
          </div>
          {prOpened && (
            <div className="report-block">
              <strong>Pull request:</strong>{' '}
              {prWorktrees.map((w) => (
                <a key={w.id} href={w.prUrl ?? '#'} target="_blank" rel="noreferrer" style={{ marginRight: 12 }}>
                  {w.repoName} #{w.prId} → {w.prDestination}
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {!job.issue && !job.solution && job.fixSummary && (
        <section className="panel">
          <h4>Resumen del fix</h4>
          <pre className="prewrap">{job.fixSummary}</pre>
        </section>
      )}

      {job.failureReason && (
        <section className="panel panel-error">
          <h4>Motivo</h4>
          <pre className="prewrap">{job.failureReason}</pre>
        </section>
      )}

      {job.filesChanged.length > 0 && (
        <section className="panel">
          <h4>Archivos tocados ({job.filesChanged.length})</h4>
          <ul className="files">
            {job.filesChanged.map((f) => (
              <li key={f} className="mono">
                {f}
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail && detail.artifacts.length > 0 && (
        <section className="panel">
          <h4>Reproduction {job.reproduction && <span className="muted">— {job.reproduction}</span>}</h4>
          <div className="evidence">
            {(['before', 'after'] as const).map((phase) => {
              const video = detail.artifacts.find((a) => a.phase === phase && a.kind === 'video');
              const shots = detail.artifacts.filter((a) => a.phase === phase && a.kind === 'screenshot');
              const trace = detail.artifacts.find((a) => a.phase === phase && a.kind === 'trace');
              if (!video && shots.length === 0 && !trace) return null;
              return (
                <div key={phase} className="evidence-col">
                  <strong>{phase === 'before' ? 'Before (bug)' : 'After (fixed)'}</strong>
                  {video && <video controls preload="metadata" src={`/api/jobs/${job.id}/artifacts/${video.id}`} />}
                  {shots.slice(0, 2).map((s) => (
                    <a key={s.id} href={`/api/jobs/${job.id}/artifacts/${s.id}`} target="_blank" rel="noreferrer">
                      <img src={`/api/jobs/${job.id}/artifacts/${s.id}`} alt={`captura ${phase}`} />
                    </a>
                  ))}
                  {trace && (
                    <a href={`/api/jobs/${job.id}/artifacts/${trace.id}`} className="muted">
                      Descargar traza (ábrela en trace.playwright.dev)
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(job.claudeSessionId || job.triageSessionId || job.status === 'working' || job.status === 'triaging') && <ClaudeSession job={job} />}

      {canMessage(job) && (
        <section className="panel">
          <h4>Mensaje para Claude Code</h4>
          <form onSubmit={(e) => void submitMessage(e)} className="answer-form">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                job.status === 'working' || job.status === 'triaging'
                  ? 'Se lo pasará cuando termine el turno actual…'
                  : 'Instrucción o contexto adicional; reabre el job y reanuda la sesión…'
              }
              rows={2}
              disabled={busy}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !message.trim()}>
              {job.status === 'working' || job.status === 'triaging' ? 'Encolar' : 'Continuar sesión'}
            </button>
          </form>
          <p className="muted">Equivale a escribir en el hilo de Slack: el hilo y este cuadro alimentan la misma sesión.</p>
        </section>
      )}

      <section className="panel">
        <h4>Log de eventos</h4>
        {!detail && !error && <p className="muted">Cargando…</p>}
        {detail && (
          <ol className="events">
            {detail.events.map((ev) => (
              <li key={ev.id}>
                <span className="muted mono">{formatDate(ev.createdAt)}</span>
                <span className={`ev-type ev-${ev.type}`}>{ev.type}</span>
                <span className="ev-msg">{ev.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="actions">
        {!isTerminal(job.status) && (
          <button type="button" className="btn btn-danger" onClick={() => void discard()} disabled={busy}>
            Descartar job
          </button>
        )}
        {job.status === 'fixed' && prEnabled && job.sourceBranch && !prDecided && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => void pullRequestDecision('open')} disabled={busy}>
              Subir rama y abrir PR
            </button>
            <button type="button" className="btn" onClick={() => void pullRequestDecision('skip')} disabled={busy}>
              No abrir PR
            </button>
          </>
        )}
        {prOpened && jiraMergeStatus && !mergeDecided && (
          <>
            <button type="button" className="btn" onClick={() => void jiraMerge('transition')} disabled={busy}>
              Mover a {jiraMergeStatus}
            </button>
            <button type="button" className="btn" onClick={() => void jiraMerge('skip')} disabled={busy}>
              Dejar estado en Jira
            </button>
          </>
        )}
        {job.status === 'fixed' && (job.issue || job.solution) && !(detail?.events ?? []).some((e) => e.type === 'jira_comment') && (
          <button type="button" className="btn btn-primary" onClick={() => void publishToJira()} disabled={busy}>
            Publicar reporte en Jira
          </button>
        )}
        {(detail?.events ?? []).some((e) => e.type === 'jira_comment') && <span className="muted">Reporte publicado en Jira</span>}
        {isTerminal(job.status) && job.worktreePath && !job.worktreeRemovedAt && (
          <button type="button" className="btn btn-danger" onClick={() => void removeWorktree()} disabled={busy}>
            Eliminar worktree del disco
          </button>
        )}
        {job.worktreeRemovedAt && <span className="muted">Worktree eliminado el {formatDate(job.worktreeRemovedAt)}</span>}
        {devMode && <DevControls job={job} onError={setError} />}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  copy,
  wide,
}: {
  label: string;
  value: string | null | undefined | React.ReactNode;
  mono?: boolean;
  copy?: boolean;
  wide?: boolean;
}) {
  const text = typeof value === 'string' ? value : null;
  return (
    <div className={`field ${wide ? 'field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      <span className={`field-value ${mono ? 'mono' : ''}`}>
        {value ?? <span className="muted">—</span>}
        {copy && text && <CopyButton text={text} />}
      </span>
    </div>
  );
}

/** Estados en los que un mensaje libre tiene sentido: se encola (working) o reabre la sesión (terminales con sesión y worktree). */
function canMessage(job: JobDto): boolean {
  if (job.status === 'working' || job.status === 'triaging') return true;
  if (job.status === 'fixed' || job.status === 'cannot_fix' || job.status === 'failed') {
    return Boolean(job.claudeSessionId && job.worktreePath && !job.worktreeRemovedAt);
  }
  return false;
}

function testsLabel(t: 'passed' | 'failed' | 'none'): string {
  return t === 'passed' ? '✅ pasaron' : t === 'failed' ? '❌ fallaron' : 'sin tests';
}

/** Solo en NODE_ENV=development: fuerza estados para ver el dashboard sin trabajo real. */
function DevControls({ job, onError }: { job: JobDto; onError: (m: string | null) => void }) {
  const [status, setStatus] = useState<JobStatus>(job.status);
  const apply = async () => {
    try {
      onError(null);
      await api.devSetStatus(job.id, status, isAwaiting(status) ? `Pregunta simulada para ${job.ticketKey}` : undefined);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <span className="dev-controls" title="Solo en desarrollo">
      <span className="muted">dev:</span>
      <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus)}>
        {JOB_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-small" onClick={() => void apply()} disabled={isTerminal(job.status)}>
        Forzar estado
      </button>
    </span>
  );
}
