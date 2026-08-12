import { createHash } from 'node:crypto';
import type { Finding, ProviderName } from './types.js';

export interface CacheEntry {
  findings: Finding[];
  inputBytes: number;
  chunks: number;
}

const store = new Map<string, CacheEntry>();

// D14 — key order is fixed: diff, provider, maxFindings. Caller applies
// defaults before calling this.
export function computeCacheKey(diff: string, provider: ProviderName, maxFindings: number): string {
  return createHash('sha256').update(JSON.stringify({ diff, provider, maxFindings })).digest('hex');
}

export function getCached(key: string): CacheEntry | undefined {
  return store.get(key);
}

// Stores the full untruncated, sorted/deduped findings list — maxFindings
// truncation happens downstream at read time.
export function setCached(key: string, entry: CacheEntry): void {
  store.set(key, entry);
}
