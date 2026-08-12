import { createHash } from 'node:crypto';
import type { Buffer } from 'node:buffer';

export type IdempotencyCheck =
  | { kind: 'new' }
  | { kind: 'match'; jobId: string }
  | { kind: 'conflict' };

const store = new Map<string, { bodyHash: string; jobId: string }>();

// D16 — hash over the raw request body bytes, captured by the caller before JSON parsing.
export function computeBodyHash(rawBody: string | Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function checkIdempotency(key: string, bodyHash: string): IdempotencyCheck {
  const stored = store.get(key);
  if (!stored) {
    return { kind: 'new' };
  }
  if (stored.bodyHash === bodyHash) {
    return { kind: 'match', jobId: stored.jobId };
  }
  return { kind: 'conflict' };
}

export function recordIdempotency(key: string, bodyHash: string, jobId: string): void {
  store.set(key, { bodyHash, jobId });
}
