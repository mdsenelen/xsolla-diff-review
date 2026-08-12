import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Job, JobStatus, Finding, Usage, JobError, SseEvent, SseListener, ReviewOptions } from './types.js';

const jobs = new Map<string, Job>();

function notify(job: Job, event: SseEvent): void {
  job.events.push(event);
  for (const listener of job.subscribers) {
    listener(event);
  }
}

export function createJob(diff: string, options: ReviewOptions): Job {
  const job: Job = {
    jobId: randomUUID(),
    diff,
    options,
    status: 'queued',
    findings: [],
    usage: {
      inputBytes: Buffer.byteLength(diff, 'utf8'),
      chunks: 0,
      cacheHit: false,
      findingsTotal: 0,
    },
    events: [],
    subscribers: new Set(),
    createdAt: Date.now(),
  };
  jobs.set(job.jobId, job);
  // no subscribers yet — this just seeds the replay log, per D15/spec.
  job.events.push({ event: 'status', status: 'queued' });
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function setStatus(job: Job, status: JobStatus): void {
  job.status = status;
  notify(job, { event: 'status', status });
}

// The only path to 'done' — both the async queue and the sync cache-hit
// path call this, so both produce the full canonical event sequence (D15).
export function completeJob(job: Job, findings: Finding[], usage: Usage): void {
  job.findings = findings;
  job.usage = usage;
  for (const finding of findings) {
    notify(job, { event: 'finding', finding });
  }
  setStatus(job, 'done');
  notify(job, { event: 'done', total: findings.length, usage });
}

export function failJob(job: Job, error: JobError): void {
  job.error = error;
  setStatus(job, 'failed');
}

export function subscribe(job: Job, listener: SseListener): () => void {
  job.subscribers.add(listener);
  return () => {
    job.subscribers.delete(listener);
  };
}

export function replay(job: Job, listener: SseListener): void {
  for (const event of job.events) {
    listener(event);
  }
}
