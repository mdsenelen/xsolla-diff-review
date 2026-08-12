import { Buffer } from 'node:buffer';
import { CHUNK_BYTES } from '../config.js';
import { splitFileSegments } from './parseDiff.js';

// D13 — split at file boundaries, greedily pack segments while the running
// byte total stays at or under CHUNK_BYTES. A single segment over CHUNK_BYTES
// becomes its own chunk alone.
export function chunkDiff(diff: string): string[] {
  const segments = splitFileSegments(diff);
  const chunks: string[] = [];
  let pending: string[] = [];
  let pendingBytes = 0;

  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    chunks.push(pending.join('\n'));
    pending = [];
    pendingBytes = 0;
  };

  for (const segment of segments) {
    const segmentBytes = Buffer.byteLength(segment.text, 'utf8');

    if (segmentBytes > CHUNK_BYTES) {
      flush();
      chunks.push(segment.text);
      continue;
    }

    const additionalBytes = pending.length === 0 ? segmentBytes : segmentBytes + 1;
    if (pending.length > 0 && pendingBytes + additionalBytes > CHUNK_BYTES) {
      flush();
      pending.push(segment.text);
      pendingBytes = segmentBytes;
    } else {
      pending.push(segment.text);
      pendingBytes += additionalBytes;
    }
  }

  flush();
  return chunks;
}
