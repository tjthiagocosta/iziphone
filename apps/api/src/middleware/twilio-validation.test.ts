import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import twilio from 'twilio';
import { describe, expect, test } from 'vitest';
import {
  createTwilioSignatureValidator,
  type TwilioSignatureOptions,
} from './twilio-validation.js';

const publicUrl = 'https://api.example.com';
const authToken = 'not-a-real-twilio-token';

async function buildWebhookApp(
  overrides: Partial<TwilioSignatureOptions> = {},
) {
  const app = Fastify({ logger: false });
  await app.register(formbody);
  app.post(
    '/webhook',
    {
      preHandler: createTwilioSignatureValidator({
        authToken,
        publicUrl,
        skipValidation: false,
        ...overrides,
      }),
    },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

describe('createTwilioSignatureValidator', () => {
  test('skips validation when asked to (development)', async () => {
    const app = await buildWebhookApp({ skipValidation: true });

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: formHeaders,
      payload: 'Body=Hello',
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  test('reports a misconfiguration when no auth token is available', async () => {
    const app = await buildWebhookApp({ authToken: null });

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: formHeaders,
      payload: 'Body=Hello',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Server misconfiguration' });
    await app.close();
  });

  test('rejects a request without a signature', async () => {
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: formHeaders,
      payload: 'Body=Hello',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Missing signature' });
    await app.close();
  });

  test('rejects a signature computed for a different url', async () => {
    const payload = { Body: 'Hello there' };
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        ...formHeaders,
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          authToken,
          'https://calls.example.com/webhook',
          payload,
        ),
      },
      payload: new URLSearchParams(payload).toString(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Invalid signature' });
    await app.close();
  });

  test('accepts a request signed for the public url and form body', async () => {
    const payload = {
      MessageSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      From: '+15555550101',
      To: '+15555550102',
      Body: 'Hello there',
    };
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        ...formHeaders,
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          authToken,
          `${publicUrl}/webhook`,
          payload,
        ),
      },
      payload: new URLSearchParams(payload).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
