import process from 'node:process';

export const VERSION = '1.0.0';

export const STARTED_AT = Date.now();

const rawBearerToken = process.env.BEARER_TOKEN;
if (!rawBearerToken) {
  throw new Error('BEARER_TOKEN environment variable is required');
}
export const BEARER_TOKEN = rawBearerToken;

export const MAX_PAYLOAD_BYTES = 1_048_576;
export const CHUNK_BYTES = 65_536;
export const MAX_CONCURRENT_JOBS = 4;
export const RATE_LIMIT_PER_MINUTE = 30;
