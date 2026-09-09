import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { ZodError } from 'zod';
import { apiErrorHandler } from './error-handler.js';
import { HttpError } from './http-error.js';

async function appThrowing(error: Error) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(apiErrorHandler);
  app.get('/', async () => {
    throw error;
  });
  await app.ready();
  return app;
}

describe('apiErrorHandler', () => {
  test('turns a validation failure into a 400 with the first issue', async () => {
    const app = await appThrowing(
      new ZodError([
        { code: 'custom', path: ['to'], message: 'First issue', input: 'x' },
        { code: 'custom', path: ['body'], message: 'Second issue', input: '' },
      ]),
    );

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'First issue',
    });
    await app.close();
  });

  test.each([
    [new HttpError('Email already in use', 409), 409, 'Conflict'],
    [new HttpError('Twilio rejected the number', 502), 502, 'Bad Gateway'],
  ])(
    'keeps the status of a service error (%s)',
    async (error, status, label) => {
      const app = await appThrowing(error);

      const response = await app.inject({ method: 'GET', url: '/' });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: label, message: error.message });
      await app.close();
    },
  );

  test('keeps a 4xx raised by Fastify itself', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(apiErrorHandler);
    app.post('/', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Bad Request' });
    await app.close();
  });

  test('hides the details of an unexpected error', async () => {
    const app = await appThrowing(
      new Error('connection to db.example.com refused'),
    );

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    await app.close();
  });
});
