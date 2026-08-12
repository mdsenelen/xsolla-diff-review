import type { FastifyInstance } from 'fastify';
import { BEARER_TOKEN } from '../config.js';
import { sendError } from './errors.js';

const BEARER_PREFIX = 'Bearer ';

// Global onRequest hook, not scoped to any route, so an unknown path under
// /v1 without a token still gets a 401 before the router ever sees it.
export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url ?? request.url;
    if (!url.startsWith('/v1/')) {
      return;
    }

    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      sendError(reply, 401, 'unauthorized', 'missing or malformed Authorization header');
      return;
    }

    const token = header.slice(BEARER_PREFIX.length);
    if (token !== BEARER_TOKEN) {
      sendError(reply, 401, 'unauthorized', 'invalid bearer token');
      return;
    }
  });
}
