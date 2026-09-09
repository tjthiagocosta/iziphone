import { describe, expect, test } from 'vitest';
import { ZodError } from 'zod';
import {
  normalizeTwilioInboundEvent,
  normalizeTwilioStatusEvent,
  parseTwilioMessagesCreateResponse,
  parseTwilioMessagesErrorResponse,
} from './messages.schemas.js';

describe('twilio-messages.schemas', () => {
  test('should parse a valid send response payload', () => {
    const parsed = parseTwilioMessagesCreateResponse({
      sid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'queued',
    });

    expect(parsed.sid).toBe('SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  test('should parse a valid error response payload', () => {
    const parsed = parseTwilioMessagesErrorResponse({
      code: 20429,
      message: 'Too Many Requests',
      more_info: 'https://www.twilio.com/docs/api/errors/20429',
      status: 429,
    });

    expect(parsed.code).toBe(20429);
  });

  test('should normalize an inbound MMS webhook payload', () => {
    const parsed = normalizeTwilioInboundEvent({
      MessageSid: 'MMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      From: '+15555550123',
      To: '+15555550100',
      Body: 'Photo',
      DateCreated: 'Mon, 06 Apr 2026 12:00:00 +0000',
      OptOutType: 'STOP',
      NumMedia: '1',
      MediaUrl0:
        'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/Media/MEcccccccccccccccccccccccccccccccc',
      MediaContentType0: 'image/png',
    });

    expect(parsed).toEqual({
      provider: 'TWILIO',
      channel: 'MMS',
      providerMessageId: 'MMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      providerTimestamp: '2026-04-06T12:00:00.000Z',
      from: '+15555550123',
      to: '+15555550100',
      body: 'Photo',
      keyword: 'STOP',
      media: [
        {
          url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/Media/MEcccccccccccccccccccccccccccccccc',
          mimeType: 'image/png',
          fileName: 'MEcccccccccccccccccccccccccccccccc',
        },
      ],
      rawPayload: expect.objectContaining({ Body: 'Photo' }),
    });
  });

  test('should normalize national numbers and blank bodies on inbound payloads', () => {
    const parsed = normalizeTwilioInboundEvent({
      SmsSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      From: '(555) 555-0123',
      To: ['+15555550100'],
      Body: '   ',
    });

    expect(parsed).toMatchObject({
      channel: 'SMS',
      providerMessageId: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      from: '+15555550123',
      to: '+15555550100',
      body: null,
      keyword: null,
      media: [],
    });
  });

  test('should reject inbound payloads without a message id or with an invalid number', () => {
    expect(() =>
      normalizeTwilioInboundEvent({ From: '+15555550123', To: '+15555550100' }),
    ).toThrow(ZodError);
    expect(() =>
      normalizeTwilioInboundEvent({
        MessageSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        From: 'not-a-number',
        To: '+15555550100',
      }),
    ).toThrow(ZodError);
  });

  test('should normalize a status webhook payload', () => {
    const parsed = normalizeTwilioStatusEvent({
      MessageSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      From: '+15555550100',
      To: '+15555550123',
      MessageStatus: 'undelivered',
      DateCreated: 'Mon, 06 Apr 2026 12:00:05 +0000',
      NumMedia: '1',
      ErrorCode: '30003',
      ErrorMessage: 'Unreachable destination handset',
      ChannelStatusMessage: 'Carrier delivery failure',
    });

    expect(parsed).toEqual({
      provider: 'TWILIO',
      channel: 'MMS',
      providerMessageId: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      providerTimestamp: '2026-04-06T12:00:05.000Z',
      from: '+15555550100',
      to: '+15555550123',
      providerStatus: 'undeliverable',
      clientReference: null,
      errorCode: '30003',
      errorText: 'Unreachable destination handset',
      errorType: 'Carrier delivery failure',
      rawPayload: expect.objectContaining({ MessageStatus: 'undelivered' }),
    });
  });

  test('should reject status payloads without a status', () => {
    expect(() =>
      normalizeTwilioStatusEvent({
        MessageSid: 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow(ZodError);
  });
});
