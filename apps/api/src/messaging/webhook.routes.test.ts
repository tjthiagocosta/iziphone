import formbody from '@fastify/formbody';
import type { FastifyInstance } from 'fastify';
import twilio from 'twilio';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  createApiRouteApp,
  testApiConfig,
} from '../test/route-test-helpers.js';
import { twilioMessagesWebhookRoutes } from './webhook.routes.js';
import { MessageWebhookService } from './webhook.service.js';

const AUTH_TOKEN = testApiConfig.twilio?.authToken ?? '';
const SENDER_NUMBER = '+15555550100';
const CONTACT_NUMBER = '+15555550123';

describe('twilioMessagesWebhookRoutes', () => {
  let app: FastifyInstance;
  let processInboundSpy: ReturnType<typeof spyOn>;
  let processStatusSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    processInboundSpy = vi
      .spyOn(MessageWebhookService.prototype, 'processInboundEvent')
      .mockResolvedValue({ outcome: 'processed' });
    processStatusSpy = vi
      .spyOn(MessageWebhookService.prototype, 'processStatusEvent')
      .mockResolvedValue({ outcome: 'processed' });

    app = await createApiRouteApp(
      async (fastify) => {
        await fastify.register(formbody);
        await fastify.register(twilioMessagesWebhookRoutes);
      },
      { db: {} },
    );
  });

  afterEach(async () => {
    await app.close();
  });

  test('should accept a valid signed inbound webhook', async () => {
    const payload = {
      MessageSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      From: CONTACT_NUMBER,
      To: SENDER_NUMBER,
      Body: 'Hello there',
      NumMedia: '0',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/inbound',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          AUTH_TOKEN,
          `${testApiConfig.publicUrl}/inbound`,
          payload,
        ),
      },
      payload: new URLSearchParams(payload).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(response.body).toContain('<Response');
    expect(processInboundSpy).toHaveBeenCalledWith(payload);
  });

  test('should accept a valid signed status webhook', async () => {
    const payload = {
      MessageSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      MessageStatus: 'delivered',
      From: SENDER_NUMBER,
      To: CONTACT_NUMBER,
      NumMedia: '0',
    };

    const response = await app.inject({
      method: 'POST',
      url: '/status',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          AUTH_TOKEN,
          `${testApiConfig.publicUrl}/status`,
          payload,
        ),
      },
      payload: new URLSearchParams(payload).toString(),
    });

    expect(response.statusCode).toBe(204);
    expect(processStatusSpy).toHaveBeenCalledWith(payload);
  });

  test('should answer 400 when the payload fails validation', async () => {
    processInboundSpy.mockRejectedValueOnce(
      new ZodError([
        {
          code: 'custom',
          path: ['MessageSid'],
          message: 'Missing required Twilio webhook parameter: MessageSid',
          input: {},
        },
      ]),
    );
    const payload = { Body: 'Hello there' };

    const response = await app.inject({
      method: 'POST',
      url: '/inbound',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilio.getExpectedTwilioSignature(
          AUTH_TOKEN,
          `${testApiConfig.publicUrl}/inbound`,
          payload,
        ),
      },
      payload: new URLSearchParams(payload).toString(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Missing required Twilio webhook parameter: MessageSid',
    });
  });

  test('should reject unsigned requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/inbound',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'Body=Hello',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Missing signature' });
    expect(processInboundSpy).not.toHaveBeenCalled();
  });
});
