import { describe, expect, test } from 'vitest';
import {
  MessageConversationListQuerySchema,
  MessageConversationSchema,
  MessageSchema,
  RequestMessageMediaUploadSchema,
  SendMmsSchema,
  SendSmsSchema,
} from './messaging.schemas.js';

const sms = {
  fromPhoneNumberId: 'phone-1',
  body: 'Hello from the support desk',
  idempotencyKey: 'send-1',
};

describe('SendSmsSchema', () => {
  test('accepts a send to a new destination', () => {
    const parsed = SendSmsSchema.parse({ ...sms, to: '+15555550100' });
    expect(parsed.to).toBe('+15555550100');
  });

  test('accepts a send into an existing conversation', () => {
    expect(
      SendSmsSchema.safeParse({ ...sms, conversationId: 'conv-1' }).success,
    ).toBe(true);
  });

  test('rejects a send with neither conversation nor destination', () => {
    expect(SendSmsSchema.safeParse(sms).success).toBe(false);
  });

  test('rejects a send with both conversation and destination', () => {
    const result = SendSmsSchema.safeParse({
      ...sms,
      conversationId: 'conv-1',
      to: '+15555550100',
    });
    expect(result.success).toBe(false);
  });

  test('rejects an undialable destination', () => {
    expect(SendSmsSchema.safeParse({ ...sms, to: 'call me' }).success).toBe(
      false,
    );
  });

  test('rejects attachments with a pointer to the MMS endpoint', () => {
    const result = SendSmsSchema.safeParse({
      ...sms,
      to: '+15555550100',
      attachments: [
        { url: 'https://example.com/a.png', mimeType: 'image/png' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/MMS/);
    }
  });

  test('bounds the body and requires an idempotency key', () => {
    expect(
      SendSmsSchema.safeParse({
        ...sms,
        to: '+15555550100',
        body: 'x'.repeat(1601),
      }).success,
    ).toBe(false);
    expect(
      SendSmsSchema.safeParse({
        ...sms,
        to: '+15555550100',
        idempotencyKey: '',
      }).success,
    ).toBe(false);
  });
});

describe('SendMmsSchema', () => {
  test('requires exactly one prepared attachment', () => {
    const base = {
      fromPhoneNumberId: 'phone-1',
      to: '+15555550100',
      idempotencyKey: 'k',
    };
    expect(
      SendMmsSchema.safeParse({ ...base, attachmentIds: [] }).success,
    ).toBe(false);
    expect(
      SendMmsSchema.safeParse({ ...base, attachmentIds: ['m1', 'm2'] }).success,
    ).toBe(false);
    expect(
      SendMmsSchema.safeParse({ ...base, attachmentIds: ['m1'] }).success,
    ).toBe(true);
  });
});

describe('RequestMessageMediaUploadSchema', () => {
  test('only accepts supported media types under the size limit', () => {
    const base = { fileName: 'receipt.pdf', sizeBytes: 1024 };
    expect(
      RequestMessageMediaUploadSchema.safeParse({
        ...base,
        mimeType: 'application/pdf',
      }).success,
    ).toBe(true);
    expect(
      RequestMessageMediaUploadSchema.safeParse({
        ...base,
        mimeType: 'video/mp4',
      }).success,
    ).toBe(false);
    expect(
      RequestMessageMediaUploadSchema.safeParse({
        ...base,
        mimeType: 'image/png',
        sizeBytes: 600 * 1024 + 1,
      }).success,
    ).toBe(false);
  });
});

describe('a thread with a sender that is not a phone number', () => {
  const timestamps = {
    lastReadAt: null,
    lastMessageAt: '2026-09-20T12:00:00.000Z',
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
  };

  /*
   * A short code and a sender id reach the client through these schemas. A
   * schema that demanded E.164 here would fail the whole response and empty a
   * reader's inbox the moment one such message arrived.
   */
  test.each(['55501', 'EXAMPLECO'])(
    'lists a conversation with %j',
    (sender) => {
      const result = MessageConversationSchema.safeParse({
        id: 'conv-1',
        contact: { id: 'contact-1', name: null, phoneNumber: sender },
        sourcePhoneNumber: {
          id: 'phone-1',
          phoneNumber: '+15555550100',
          label: 'Support',
        },
        owner: { type: 'user', id: 'user-1', name: 'Dana Whitfield' },
        unreadCount: 1,
        lastMessagePreview: 'Your code is 4321',
        lastMessageDirection: 'INBOUND',
        lastMessageStatus: 'RECEIVED',
        isSuppressed: false,
        ...timestamps,
      });

      expect(result.success).toBe(true);
    },
  );

  test.each(['55501', 'EXAMPLECO'])('shows a message from %j', (sender) => {
    const result = MessageSchema.safeParse({
      id: 'message-1',
      conversationId: 'conv-1',
      direction: 'INBOUND',
      channel: 'SMS',
      status: 'RECEIVED',
      body: 'Your code is 4321',
      from: sender,
      to: '+15555550100',
      failureCode: null,
      failureReason: null,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      createdAt: '2026-09-20T12:00:00.000Z',
      attachments: [],
    });

    expect(result.success).toBe(true);
  });
});

describe('MessageConversationListQuerySchema', () => {
  test('caps the page size at 50 and parses flags from strings', () => {
    expect(
      MessageConversationListQuerySchema.safeParse({ limit: 51 }).success,
    ).toBe(false);
    expect(
      MessageConversationListQuerySchema.parse({ unreadOnly: 'false' })
        .unreadOnly,
    ).toBe(false);
  });
});
