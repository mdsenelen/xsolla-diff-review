import type { Job } from './types.js';
import { MAX_CONCURRENT_JOBS } from '../config.js';

export type JobProcessor = (job: Job) => Promise<void>;

// Generic worker pool, no knowledge of diffs or jobStore — the caller's
// processor is the only thing that touches job semantics.
export function createQueue(process: JobProcessor): { enqueue(job: Job): void } {
  const pending: Job[] = [];
  let active = 0;

  const pump = (): void => {
    while (active < MAX_CONCURRENT_JOBS && pending.length > 0) {
      const job = pending.shift()!;
      active++;
      process(job)
        .catch(() => {})
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return {
    enqueue(job: Job): void {
      pending.push(job);
      pump();
    },
  };
}
