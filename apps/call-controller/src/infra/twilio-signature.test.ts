import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import twilio from 'twilio';
import { describe, expect, test } from 'vitest';
import {
  createTwilioSignatureValidator,
  type TwilioSignatureOptions,
} from './twilio-signature.js';

const publicUrl = 'https://calls.example.com';
const authToken = 'not-a-real-twilio-token';
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

async function buildWebhookApp(
  overrides: Partial<TwilioSignatureOptions> = {},
) {
  const app = Fastify({ logger: false });
  await app.register(formbody);
  app.post(
    '/webhooks/twilio/voice/inbound',
    {
      preHandler: createTwilioSignatureValidator({
        signer: { authToken, publicUrl },
        skipValidation: false,
        ...overrides,
      }),
    },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

describe('createTwilioSignatureValidator', () => {
  test('skips validation when asked to (development)', async () => {
    const app = await buildWebhookApp({ skipValidation: true });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/voice/inbound',
      headers: formHeaders,
      payload: 'CallSid=CA123',
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  test('reports a misconfiguration when Twilio is not configured', async () => {
    const app = await buildWebhookApp({ signer: null });

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/voice/inbound',
      headers: formHeaders,
      payload: 'CallSid=CA123',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Server misconfiguration' });
    await app.close();
  });

  test('rejects a request without a signature', async () => {
    const app = await buildWebhookApp();

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/voice/inbound',
      headers: formHeaders,
      payload: 'CallSid=CA123',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Missing signature' });
    await app.close();
  });

  test('rejects a signature made for a different body', async () => {
    const app = await buildWebhookApp();
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      `${publicUrl}/webhooks/twilio/voice/inbound`,
      { CallSid: 'CA999' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/voice/inbound',
      headers: { ...formHeaders, 'x-twilio-signature': signature },
      payload: 'CallSid=CA123',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Invalid signature' });
    await app.close();
  });

  test('accepts a request Twilio signed against the public url', async () => {
    const app = await buildWebhookApp();
    const signature = twilio.getExpectedTwilioSignature(
      authToken,
      `${publicUrl}/webhooks/twilio/voice/inbound?conversationUuid=CA123`,
      { CallSid: 'CA123', From: '+15555550101' },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/twilio/voice/inbound?conversationUuid=CA123',
      headers: { ...formHeaders, 'x-twilio-signature': signature },
      payload: 'CallSid=CA123&From=%2B15555550101',
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
