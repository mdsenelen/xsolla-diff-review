import process from 'node:process';
import type { Buffer } from 'node:buffer';
import Fastify from 'fastify';
import { MAX_PAYLOAD_BYTES } from './config.js';
import { registerErrorHandling } from './http/errors.js';
import { registerAuth } from './http/auth.js';
import { registerRoutes } from './http/routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody: Buffer;
  }
}

const app = Fastify({ bodyLimit: MAX_PAYLOAD_BYTES });

// Captures the raw request bytes onto request.rawBody before JSON parsing,
// since D16 idempotency hashing needs the raw bytes, not the parsed object.
app.addContentTypeParser<Buffer>('application/json', { parseAs: 'buffer' }, (request, body, done) => {
  request.rawBody = body;
  if (body.length === 0) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(body.toString('utf8')));
  } catch (err) {
    const parseError = err instanceof Error ? err : new Error('invalid json');
    (parseError as Error & { statusCode?: number }).statusCode = 400;
    done(parseError, undefined);
  }
});

registerErrorHandling(app);
registerAuth(app);
registerRoutes(app);

const PORT = process.env.PORT ?? '3000';

app.listen({ port: Number(PORT), host: '0.0.0.0' }).catch(() => {
  process.exit(1);
});

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown().catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  shutdown().catch(() => process.exit(1));
});
