import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerErrorHandler } from './error-handler.js';

/**
 * The error handler is the last thing between a thrown value and the client, so
 * the cases worth pinning here are the ones no route deliberately produces:
 * errors from inside a dependency, and values that are not Errors at all.
 *
 * These reach the handler by throwing directly rather than by sending a
 * malformed request, because that is the only way to reach them at all —
 * @fastify/multipart rejects an unsupported content type itself, so busboy's own
 * 'Unsupported Content-Type.' never fires over HTTP. It is mapped anyway: the
 * cost is one line, and the alternative is a 500 if a future version of
 * @fastify/multipart stops checking first.
 */
describe('error handler — values it must never answer with a 500', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.post('/throws', async (request) => {
      const { message, plain } = request.body as { message?: string; plain?: boolean };
      // A value with no string `message` — the branch that exists so a
      // non-Error throw cannot take the process down with it.
      if (plain) throw { notAnError: true, message: 404 };
      throw new Error(message);
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/throws', payload: body });

  it('maps busboy’s missing-boundary error to 400, not 500', async () => {
    const response = await post({ message: 'Multipart: Boundary not found' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('MALFORMED_MULTIPART');
  });

  it('maps busboy’s unsupported-content-type error to 415', async () => {
    const response = await post({ message: 'Unsupported Content-Type.' });

    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('never repeats the parser’s own wording back to the client', async () => {
    // The message names a dependency and its internals. What the client gets
    // has to be about the request, not about what we happen to parse it with.
    const body = JSON.stringify((await post({ message: 'Multipart: Boundary not found' })).json());

    expect(body).not.toContain('Boundary not found');
    expect(body).not.toContain('busboy');
    expect(body).not.toContain('Multipart:');
  });

  it('answers a thrown non-Error with a clean 500 rather than crashing', async () => {
    const response = await post({ plain: true });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.json().error.message).toBe('Something went wrong.');
    // A numeric `message` must not be mistaken for a status or a busboy match.
    expect(response.json().error).not.toHaveProperty('details');
  });

  it('leaves an unrecognised error message as a 500', async () => {
    const response = await post({ message: 'something else entirely' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
  });
});
