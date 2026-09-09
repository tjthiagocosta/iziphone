import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type TwilioMessagesApiError,
  TwilioMessagesService,
  TwilioMessagesTransportError,
} from './messages.service.js';

const ACCOUNT_SID = 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AUTH_TOKEN = 'not-a-real-twilio-token';
const SENDER_NUMBER = '+15555550100';
const CONTACT_NUMBER = '+15555550123';

describe('TwilioMessagesService', () => {
  const fetchMock = vi.fn<typeof fetch>();

  let service: TwilioMessagesService;

  beforeEach(() => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            sid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'queued',
          }),
          {
            status: 201,
            headers: {
              'content-type': 'application/json',
              'twilio-request-id': 'request-1',
            },
          },
        ),
    );

    service = new TwilioMessagesService({
      fetch: fetchMock,
      credentials: { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN },
      publicUrl: 'https://api.example.com',
    });
  });

  test('should send an SMS through the Messages API', async () => {
    const result = await service.sendSms({
      from: SENDER_NUMBER,
      to: CONTACT_NUMBER,
      text: 'Hello there',
      clientReference: 'sms-1',
    });

    expect(result).toEqual({
      outcome: 'accepted',
      provider: 'TWILIO',
      channel: 'SMS',
      providerMessageId: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      clientReference: 'sms-1',
      requestId: 'request-1',
      request: {
        To: CONTACT_NUMBER,
        From: SENDER_NUMBER,
        Body: 'Hello there',
        StatusCallback:
          'https://api.example.com/webhooks/twilio/messages/status',
      },
      response: {
        sid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        status: 'queued',
      },
      responseHeaders: {
        'content-type': 'application/json',
        'twilio-request-id': 'request-1',
      },
    });

    const [url, request] = fetchMock.mock.calls[0] ?? [];

    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    );
    expect(request?.headers).toEqual(
      expect.objectContaining({
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      }),
    );

    const payload = Object.fromEntries(
      new URLSearchParams((request?.body as string) ?? '').entries(),
    );

    expect(payload).toEqual({
      To: CONTACT_NUMBER,
      From: SENDER_NUMBER,
      Body: 'Hello there',
      StatusCallback: 'https://api.example.com/webhooks/twilio/messages/status',
    });
  });

  test('should send an MMS with its media URL and an optional caption', async () => {
    await service.sendMms({
      from: SENDER_NUMBER,
      to: CONTACT_NUMBER,
      text: null,
      clientReference: 'mms-1',
      mediaUrl: 'https://api.example.com/media/messaging/prepared/prepared-1',
      mediaType: 'image/png',
    });

    const [, request] = fetchMock.mock.calls[0] ?? [];
    const payload = Object.fromEntries(
      new URLSearchParams((request?.body as string) ?? '').entries(),
    );

    expect(payload).toEqual({
      To: CONTACT_NUMBER,
      From: SENDER_NUMBER,
      MediaUrl: 'https://api.example.com/media/messaging/prepared/prepared-1',
      StatusCallback: 'https://api.example.com/webhooks/twilio/messages/status',
    });
  });

  test('should classify retryable API errors', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            code: 20429,
            message: 'Too Many Requests',
            more_info: 'https://www.twilio.com/docs/api/errors/20429',
            status: 429,
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'twilio-request-id': 'request-2',
            },
          },
        ),
    );

    await expect(
      service.sendSms({
        from: SENDER_NUMBER,
        to: CONTACT_NUMBER,
        text: 'Hello there',
        clientReference: 'sms-2',
      }),
    ).rejects.toMatchObject({
      name: 'TwilioMessagesApiError',
      errorCode: '20429',
      retriable: true,
      requestId: 'request-2',
    } satisfies Partial<TwilioMessagesApiError>);
  });

  test('should raise a transport error for invalid JSON responses', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('not-json'));

    await expect(
      service.sendSms({
        from: SENDER_NUMBER,
        to: CONTACT_NUMBER,
        text: 'Hello there',
        clientReference: 'sms-3',
      }),
    ).rejects.toBeInstanceOf(TwilioMessagesTransportError);
  });

  test('should fail fast without calling Twilio when credentials are missing', async () => {
    const unconfigured = new TwilioMessagesService({
      fetch: fetchMock,
      credentials: null,
      publicUrl: 'https://api.example.com',
    });

    await expect(
      unconfigured.sendSms({
        from: SENDER_NUMBER,
        to: CONTACT_NUMBER,
        text: 'Hello there',
        clientReference: 'sms-4',
      }),
    ).rejects.toThrow(/Twilio credentials are not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
