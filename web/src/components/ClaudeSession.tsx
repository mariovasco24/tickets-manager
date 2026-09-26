import { useEffect, useRef, useState } from 'react';
import type { JobDto, JobMessageDto } from '../../../src/shared/job-types';
import { api } from '../api';
import { subscribeMessages } from '../live';

interface Props {
  job: JobDto;
}

/**
 * Transcripción en vivo de la sesión de Claude Code: texto del agente, llamadas
 * a herramientas con su entrada y resultado (plegables) y el cierre de cada
 * ejecución. Carga el histórico por REST y se actualiza por SSE.
 */
export function ClaudeSession({ job }: Props) {
  const [messages, setMessages] = useState<JobMessageDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .messages(job.id)
      .then((m) => {
        if (!cancelled) setMessages(m);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    const unsubscribe = subscribeMessages(job.id, (msg) => {
      setMessages((prev) => (prev.some((p) => p.id === msg.id) ? prev : [...prev, msg]));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [job.id]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, autoScroll]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  };

  const live = job.status === 'working' || job.status === 'triaging';
  const inTriage = job.phase === 'triage' && !job.claudeSessionId;
  const sessionId = inTriage ? job.triageSessionId : job.claudeSessionId;

  return (
    <section className="panel session">
      <header className="session-head">
        <h4>
          {inTriage ? 'Sesión de triaje (repo de conocimiento)' : 'Sesión de Claude Code'} {live && <span className="live-dot" title="En curso" />}
        </h4>
        <span className="muted">
          {sessionId ? <code>{sessionId}</code> : 'sin sesión todavía'}
          {!inTriage && job.triageSessionId && <span title="Sesión de triaje previa"> · triaje incluido</span>}
          {job.claudeNumTurns != null && ` · ${job.claudeNumTurns} turnos`}
          {job.claudeCostUsd != null && ` · $${job.claudeCostUsd.toFixed(4)}`}
          {job.clarificationRounds > 0 && ` · ${job.clarificationRounds} aclaración(es)`}
        </span>
      </header>
      {error && <p className="error">{error}</p>}
      {messages.length === 0 && !error && (
        <p className="muted">{live ? 'Esperando los primeros eventos…' : 'Claude Code no se ha ejecutado para este job.'}</p>
      )}
      <div className="session-list" ref={listRef} onScroll={onScroll}>
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>
      {!autoScroll && messages.length > 0 && (
        <button type="button" className="btn btn-small session-follow" onClick={() => setAutoScroll(true)}>
          ↓ Seguir en vivo
        </button>
      )}
    </section>
  );
}

function Message({ m }: { m: JobMessageDto }) {
  const time = new Date(m.createdAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  switch (m.kind) {
    case 'assistant_text':
      return (
        <div className="msg msg-assistant">
          <span className="msg-time">{time}</span>
          <pre className="prewrap">{String(m.content ?? m.summary)}</pre>
        </div>
      );
    case 'user_prompt':
      return (
        <Collapsible className="msg msg-user" time={time} title={`→ ${m.summary}`}>
          <pre className="prewrap">{String(m.content ?? '')}</pre>
        </Collapsible>
      );
    case 'tool_use':
      return (
        <Collapsible className="msg msg-tool" time={time} title={<><span className="tool-name">{m.toolName}</span> {m.summary}</>}>
          <pre className="prewrap">{formatContent(m.content)}</pre>
        </Collapsible>
      );
    case 'tool_result': {
      const c = (m.content ?? {}) as { isError?: boolean; text?: string };
      return (
        <Collapsible className={`msg msg-result ${c.isError ? 'msg-error' : ''}`} time={time} title={`↳ ${m.summary}`}>
          <pre className="prewrap">{c.text ?? ''}</pre>
        </Collapsible>
      );
    }
    case 'system':
      return (
        <Collapsible className="msg msg-system" time={time} title={m.summary}>
          <pre className="prewrap">{formatContent(m.content)}</pre>
        </Collapsible>
      );
    case 'result':
    case 'error': {
      const c = (m.content ?? {}) as { result?: string };
      return (
        <Collapsible className={`msg msg-final ${m.kind === 'error' ? 'msg-error' : ''}`} time={time} title={m.summary} defaultOpen={m.kind === 'error'}>
          <pre className="prewrap">{c.result ?? formatContent(m.content)}</pre>
        </Collapsible>
      );
    }
    default:
      return (
        <div className="msg">
          <span className="msg-time">{time}</span> {m.summary}
        </div>
      );
  }
}

function Collapsible({
  className,
  time,
  title,
  children,
  defaultOpen = false,
}: {
  className: string;
  time: string;
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button type="button" className="msg-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="msg-time">{time}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="msg-title">{title}</span>
      </button>
      {open && <div className="msg-body">{children}</div>}
    </div>
  );
}

function formatContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content, null, 2);
}
