import type { JobMessageDto } from '../../src/shared/job-types';

type Listener = (message: JobMessageDto) => void;

/**
 * Bus mínimo para repartir los mensajes de sesión que llegan por el único
 * EventSource (useJobs) a los paneles de sesión abiertos, por job.
 */
const listeners = new Map<string, Set<Listener>>();

export function subscribeMessages(jobId: string, fn: Listener): () => void {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) listeners.delete(jobId);
  };
}

export function publishMessage(message: JobMessageDto): void {
  listeners.get(message.jobId)?.forEach((fn) => fn(message));
}
