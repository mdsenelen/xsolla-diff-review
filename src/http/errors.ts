import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export type ErrorCode =
  | 'unauthorized'
  | 'payload_too_large'
  | 'invalid_json'
  | 'invalid_diff'
  | 'idempotency_conflict'
  | 'not_found'
  | 'rate_limited'
  | 'internal';

export function sendError(reply: FastifyReply, statusCode: number, code: ErrorCode, message: string): void {
  reply.code(statusCode).send({ error: { code, message } });
}

// Maps Fastify's own framework errors (body limit, malformed JSON, unhandled
// throws) into the contract's error envelope. Nothing may leak Fastify's
// default {statusCode, error, message} body.
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413) {
      sendError(reply, 413, 'payload_too_large', 'request body exceeds the maximum payload size');
      return;
    }
    if (error.statusCode === 400) {
      sendError(reply, 400, 'invalid_json', 'request body is not valid JSON');
      return;
    }
    sendError(reply, 500, 'internal', 'internal server error');
  });

  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, 404, 'not_found', 'resource not found');
  });
}
