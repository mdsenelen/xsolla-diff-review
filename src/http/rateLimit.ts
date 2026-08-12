import { RATE_LIMIT_PER_MINUTE } from '../config.js';

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const REFILL_PER_SECOND = RATE_LIMIT_PER_MINUTE / 60;

const buckets = new Map<string, Bucket>();

// Token bucket keyed by bearer token. Capacity RATE_LIMIT_PER_MINUTE,
// refilling continuously at REFILL_PER_SECOND tokens/sec.
export function checkRateLimit(token: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now();
  let bucket = buckets.get(token);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_PER_MINUTE, lastRefillMs: now };
    buckets.set(token, bucket);
  }

  const elapsedMs = now - bucket.lastRefillMs;
  bucket.tokens = Math.min(RATE_LIMIT_PER_MINUTE, bucket.tokens + elapsedMs * (REFILL_PER_SECOND / 1000));
  bucket.lastRefillMs = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }

  const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / REFILL_PER_SECOND);
  return { allowed: false, retryAfterSeconds };
}
