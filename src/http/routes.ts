import type { FastifyInstance } from 'fastify';
import { CHUNK_BYTES, MAX_CONCURRENT_JOBS, MAX_PAYLOAD_BYTES, RATE_LIMIT_PER_MINUTE, STARTED_AT, VERSION } from '../config.js';
import type { Job, ProviderName } from '../core/types.js';
import { completeJob, createJob, failJob, getJob, setStatus } from '../core/jobStore.js';
import { createQueue } from '../core/queue.js';
import { computeCacheKey, getCached, setCached } from '../core/cache.js';
import { checkIdempotency, computeBodyHash, recordIdempotency } from '../core/idempotency.js';
import { chunkDiff } from '../core/chunk.js';
import { normalizeFindings } from '../core/normalize.js';
import { isParseableDiff } from '../core/parseDiff.js';
import { getProvider } from '../providers/index.js';
import { sendError } from './errors.js';
import { checkRateLimit } from './rateLimit.js';
import { handleSseStream } from './sse.js';

const BEARER_PREFIX = 'Bearer ';

async function processJob(job: Job): Promise<void> {
  try {
    setStatus(job, 'running');
    const provider = getProvider(job.options.provider);
    const chunks = chunkDiff(job.diff);
    const rawFindings = await provider.review(chunks, job.options);
    const full = normalizeFindings(rawFindings, Number.POSITIVE_INFINITY);
    const { findings: truncated, findingsTotal } = normalizeFindings(full.findings, job.options.maxFindings);
    const usage = { inputBytes: job.usage.inputBytes, chunks: chunks.length, cacheHit: false, findingsTotal };
    setCached(computeCacheKey(job.diff, job.options.provider, job.options.maxFindings), { findings: full.findings, inputBytes: usage.inputBytes, chunks: usage.chunks });
    completeJob(job, truncated, usage);
  } catch (err) {
    failJob(job, { code: 'internal', message: err instanceof Error ? err.message : 'unknown error' });
  }
}

const queue = createQueue(processJob);

interface ReviewRequestBody {
  diff?: unknown;
  options?: {
    provider?: unknown;
    maxFindings?: unknown;
  };
}

export function registerRoutes(app: FastifyInstance): void {
  app.get('/health', async (_request, reply) => {
    reply.code(200).send({
      status: 'ok',
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    });
  });

  app.get('/spec', async (_request, reply) => {
    reply.code(200).send({
      specVersion: '1.0',
      providers: ['mock', 'llm'],
      limits: {
        maxPayloadBytes: MAX_PAYLOAD_BYTES,
        chunkBytes: CHUNK_BYTES,
        maxConcurrentJobs: MAX_CONCURRENT_JOBS,
        rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
      },
    });
  });

  app.post('/v1/reviews', async (request, reply) => {
    const body = request.body as ReviewRequestBody | undefined;

    if (typeof body?.diff !== 'string' || body.diff.length === 0 || !isParseableDiff(body.diff)) {
      sendError(reply, 422, 'invalid_diff', 'diff must be a non-empty unified diff string');
      return;
    }
    const diff = body.diff;

    const optionsBody = body.options ?? {};
    const provider: ProviderName = optionsBody.provider === 'llm' ? 'llm' : 'mock';
    const maxFindings = typeof optionsBody.maxFindings === 'number' ? optionsBody.maxFindings : 100;

    const idempotencyKeyHeader = request.headers['idempotency-key'];
    const idempotencyKey = typeof idempotencyKeyHeader === 'string' ? idempotencyKeyHeader : undefined;
    let bodyHash: string | undefined;

    if (idempotencyKey !== undefined) {
      bodyHash = computeBodyHash(request.rawBody);
      const check = checkIdempotency(idempotencyKey, bodyHash);
      if (check.kind === 'conflict') {
        sendError(reply, 409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body');
        return;
      }
      if (check.kind === 'match') {
        reply.code(202).send({ jobId: check.jobId, status: 'queued' });
        return;
      }
    }

    const authHeader = request.headers.authorization;
    const token = typeof authHeader === 'string' && authHeader.startsWith(BEARER_PREFIX) ? authHeader.slice(BEARER_PREFIX.length) : '';
    const rateResult = checkRateLimit(token);
    if (!rateResult.allowed) {
      reply.header('Retry-After', String(rateResult.retryAfterSeconds));
      sendError(reply, 429, 'rate_limited', 'rate limit exceeded');
      return;
    }

    const cacheKey = computeCacheKey(diff, provider, maxFindings);
    const cached = getCached(cacheKey);

    let job: Job;
    if (cached) {
      job = createJob(diff, { provider, maxFindings });
      setStatus(job, 'running');
      completeJob(job, cached.findings.slice(0, maxFindings), {
        inputBytes: cached.inputBytes,
        chunks: cached.chunks,
        cacheHit: true,
        findingsTotal: cached.findings.length,
      });
    } else {
      job = createJob(diff, { provider, maxFindings });
      queue.enqueue(job);
    }

    if (idempotencyKey !== undefined && bodyHash !== undefined) {
      recordIdempotency(idempotencyKey, bodyHash, job.jobId);
    }

    reply.code(202).send({ jobId: job.jobId, status: 'queued' });
  });

  app.get('/v1/reviews/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = getJob(jobId);
    if (!job) {
      sendError(reply, 404, 'not_found', `job ${jobId} not found`);
      return;
    }
    reply.code(200).send({
      jobId: job.jobId,
      status: job.status,
      usage: job.usage,
      ...(job.status === 'done' ? { findings: job.findings } : {}),
      ...(job.status === 'failed' && job.error ? { error: job.error } : {}),
    });
  });

  app.get('/v1/reviews/:jobId/stream', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = getJob(jobId);
    if (!job) {
      sendError(reply, 404, 'not_found', `job ${jobId} not found`);
      return;
    }
    handleSseStream(job, reply);
  });
}
