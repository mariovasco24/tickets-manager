import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobDto, JobMessageDto } from '../../src/shared/job-types';
import { api } from './api';
import { publishMessage } from './live';

export type LiveMode = 'sse' | 'polling' | 'connecting';

const POLL_MS = 5000;

/**
 * Mantiene la lista de jobs al día: carga inicial por REST, actualizaciones por
 * SSE (/api/events) y, si el stream falla, polling cada 5 s hasta que vuelva.
 */
export function useJobs(): { jobs: JobDto[]; mode: LiveMode; error: string | null; refresh: () => Promise<void> } {
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await api.jobs());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();

    const stopPolling = () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
    const startPolling = () => {
      if (pollTimer.current !== null) return;
      setMode('polling');
      pollTimer.current = window.setInterval(() => void refresh(), POLL_MS);
    };

    const es = new EventSource('/api/events');
    es.addEventListener('hello', () => {
      stopPolling();
      setMode('sse');
      void refresh(); // por si hubo cambios mientras estábamos desconectados
    });
    es.addEventListener('job', (ev) => {
      const job = JSON.parse((ev as MessageEvent<string>).data) as JobDto;
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id);
        if (idx === -1) return [job, ...prev];
        const next = prev.slice();
        next[idx] = job;
        return next;
      });
    });
    es.addEventListener('message', (ev) => {
      publishMessage(JSON.parse((ev as MessageEvent<string>).data) as JobMessageDto);
    });
    es.onerror = () => startPolling(); // EventSource reintenta solo; mientras, polling

    return () => {
      es.close();
      stopPolling();
    };
  }, [refresh]);

  return { jobs, mode, error, refresh };
}
