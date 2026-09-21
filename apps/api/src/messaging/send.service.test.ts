import type { PrismaClient } from '@repo/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MessagingMediaError } from './media.service.js';
import { MessageSendService } from './send.service.js';
import {
  TwilioMessagesApiError,
  TwilioMessagesTransportError,
} from './twilio/messages.service.js';

const SENDER_NUMBER = '+15555550100';
const CONTACT_NUMBER = '+15555550123';

describe('MessageSendService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  test('should create a conversation-backed outbound message for a raw number send', async () => {
    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: '(555) 555-0123',
      body: 'Hello there',
      idempotencyKey: 'sms-1',
    });

    expect(harness.conversationService.findOrCreateFor).toHaveBeenCalledWith(
      CONTACT_NUMBER,
      'phone-1',
      expect.any(Object),
    );
    expect(harness.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          direction: 'OUTBOUND',
          channel: 'SMS',
          clientReference: 'sms-1',
        }),
      }),
    );
    expect(harness.transport.sendSms).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: 'sent',
      conversationId: 'conversation-1',
      message: {
        id: 'message-1',
        conversationId: 'conversation-1',
        direction: 'OUTBOUND',
        channel: 'SMS',
        status: 'ACCEPTED',
        body: 'Hello there',
        from: SENDER_NUMBER,
        to: CONTACT_NUMBER,
        failureCode: null,
        failureReason: null,
        sentAt: expect.any(String),
        deliveredAt: null,
        failedAt: null,
        createdAt: '2026-04-02T12:00:00.000Z',
        attachments: [],
      },
    });
  });

  test('should send within an existing conversation without creating a new conversation', async () => {
    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      conversationId: 'conversation-1',
      body: 'Hello there',
      idempotencyKey: 'sms-2',
    });

    expect(
      harness.conversationService.getAccessibleRecordForUser,
    ).toHaveBeenCalledWith('user-1', 'conversation-1', expect.any(Object));
    expect(harness.conversationService.findOrCreateFor).not.toHaveBeenCalled();
    expect(result.outcome).toBe('sent');
  });

  test('should send from a department-owned sender', async () => {
    harness.senderService.getAllowedSmsSender.mockResolvedValueOnce({
      id: 'phone-2',
      phoneNumber: '+15555550111',
      label: 'Billing',
      isPrimary: true,
      smsEnabled: true,
      mmsEnabled: true,
      userId: null,
      departmentId: 'department-1',
    });
    harness.conversationService.findOrCreateFor.mockResolvedValueOnce(
      buildConversation({
        id: 'conversation-2',
        contactId: 'contact-2',
        sourcePhoneNumberId: 'phone-2',
        userId: null,
        departmentId: 'department-1',
        contact: {
          id: 'contact-2',
          name: 'Customer',
          phoneNumber: '+15555550124',
        },
        sourcePhoneNumber: {
          id: 'phone-2',
          phoneNumber: '+15555550111',
          label: 'Billing',
        },
      }),
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-2',
      to: '+15555550124',
      body: 'Hello from billing',
      idempotencyKey: 'sms-department-1',
    });

    expect(harness.conversationService.findOrCreateFor).toHaveBeenCalledWith(
      '+15555550124',
      'phone-2',
      expect.any(Object),
    );
    expect(result).toMatchObject({
      outcome: 'sent',
      message: { from: '+15555550111' },
    });
  });

  test('should send a valid outbound MMS', async () => {
    const result = await harness.service.sendMms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Photo',
      attachmentIds: ['prepared-1'],
      idempotencyKey: 'mms-1',
    });

    expect(harness.mediaService.getPreparedMediaForSend).toHaveBeenCalledWith(
      'user-1',
      'prepared-1',
    );
    expect(harness.transport.sendMms).toHaveBeenCalledWith({
      from: SENDER_NUMBER,
      to: CONTACT_NUMBER,
      text: 'Photo',
      clientReference: 'mms-1',
      mediaUrl: 'https://api.example.com/media/prepared-1',
      mediaType: 'image/png',
    });
    expect(
      harness.mediaService.promotePreparedMediaToMessage,
    ).toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'sent',
      message: {
        channel: 'MMS',
        attachments: [expect.objectContaining({ id: 'media-1' })],
      },
    });
  });

  test('should refuse sends when the sender is not allowed', async () => {
    harness.senderService.getAllowedSmsSender.mockResolvedValueOnce(null);

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-404',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-3',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'sender_not_found',
      detail: 'Sender number not found',
    });
    expect(harness.messageCreate).not.toHaveBeenCalled();
  });

  test('should refuse MMS sends when the sender is not MMS-capable', async () => {
    harness.senderService.getAllowedMmsSender.mockResolvedValueOnce(null);

    const result = await harness.service.sendMms('user-1', {
      fromPhoneNumberId: 'phone-404',
      to: CONTACT_NUMBER,
      body: 'Photo',
      attachmentIds: ['prepared-1'],
      idempotencyKey: 'mms-2',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'sender_not_found',
      detail: 'Sender number not found',
    });
  });

  test('should refuse MMS sends when the attachment cannot be used', async () => {
    harness.mediaService.getPreparedMediaForSend.mockRejectedValueOnce(
      new MessagingMediaError('expired', 'Prepared media has expired'),
    );

    const result = await harness.service.sendMms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Photo',
      attachmentIds: ['prepared-1'],
      idempotencyKey: 'mms-expired',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'attachment_unavailable',
      detail: 'Prepared media has expired',
    });
    expect(harness.transport.sendMms).not.toHaveBeenCalled();
  });

  test('should refuse sends when the conversation sender does not match', async () => {
    harness.conversationService.getAccessibleRecordForUser.mockResolvedValueOnce(
      buildConversation({
        sourcePhoneNumberId: 'phone-2',
        sourcePhoneNumber: {
          id: 'phone-2',
          phoneNumber: '+15555550150',
          label: 'Sales',
        },
      }),
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      conversationId: 'conversation-1',
      body: 'Hello there',
      idempotencyKey: 'sms-4',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'sender_mismatch',
      detail: 'Conversation sender does not match fromPhoneNumberId',
    });
    expect(harness.transport.sendSms).not.toHaveBeenCalled();
  });

  test('should refuse sends when the conversation is not accessible', async () => {
    harness.conversationService.getAccessibleRecordForUser.mockResolvedValueOnce(
      null,
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      conversationId: 'conversation-403',
      body: 'Hello there',
      idempotencyKey: 'sms-inaccessible',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'conversation_not_found',
      detail: 'Message conversation not found',
    });
  });

  test('should persist a failed message and skip the provider for suppressed recipients', async () => {
    harness.messageSuppressionFindFirst.mockResolvedValueOnce({
      keyword: 'STOP',
      reason: 'Recipient requested opt-out',
    });

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-5',
    });

    expect(result).toMatchObject({
      outcome: 'suppressed',
      conversationId: 'conversation-1',
      message: {
        status: 'FAILED',
        failureCode: 'recipient_suppressed',
        failureReason: 'Recipient requested opt-out',
      },
    });
    expect(harness.transport.sendSms).not.toHaveBeenCalled();
    expect(harness.storedMessage()).toMatchObject({
      status: 'FAILED',
      failureCode: 'recipient_suppressed',
    });
  });

  test('should refuse invalid raw destination numbers before touching the conversation', async () => {
    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: 'abc',
      body: 'Hello there',
      idempotencyKey: 'sms-invalid-destination',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'invalid_destination',
      detail:
        'Phone number must be a valid E.164 or 10-digit North American number',
    });
    expect(harness.conversationService.findOrCreateFor).not.toHaveBeenCalled();
    expect(harness.transport.sendSms).not.toHaveBeenCalled();
  });

  test('should refuse a reply to a sender the provider cannot deliver to', async () => {
    // A service that texts from its own name has no address an answer could go
    // to, so the send is refused here instead of at the provider.
    harness.conversationService.getAccessibleRecordForUser.mockResolvedValueOnce(
      buildConversation({
        contact: { id: 'contact-3', name: null, phoneNumber: 'EXAMPLECO' },
      }),
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      conversationId: 'conversation-1',
      body: 'Hello there',
      idempotencyKey: 'sms-undeliverable',
    });

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'undeliverable_destination',
      detail: 'This sender cannot receive replies',
    });
    expect(harness.messageCreate).not.toHaveBeenCalled();
    expect(harness.transport.sendSms).not.toHaveBeenCalled();
  });

  test('should allow a reply to a short code', async () => {
    harness.conversationService.getAccessibleRecordForUser.mockResolvedValueOnce(
      buildConversation({
        contact: { id: 'contact-4', name: null, phoneNumber: '55501' },
      }),
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      conversationId: 'conversation-1',
      body: 'STOP',
      idempotencyKey: 'sms-short-code',
    });

    expect(result.outcome).toBe('sent');
    expect(harness.transport.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: '55501' }),
    );
  });

  test('should persist rejected provider responses', async () => {
    harness.transport.sendSms.mockRejectedValueOnce(
      new TwilioMessagesApiError(
        'The destination number is not reachable via Twilio',
        {
          request: {
            To: CONTACT_NUMBER,
            From: SENDER_NUMBER,
            Body: 'Hello there',
          },
          responseStatus: 400,
          responseBody: JSON.stringify({
            code: 21614,
            message: 'The destination number is not reachable via Twilio',
            more_info: 'https://www.twilio.com/docs/api/errors/21614',
            status: 400,
          }),
          responseHeaders: {
            'twilio-request-id': 'request-6',
          },
          requestId: 'request-6',
          error: {
            code: 21614,
            message: 'The destination number is not reachable via Twilio',
            more_info: 'https://www.twilio.com/docs/api/errors/21614',
            status: 400,
          },
        },
      ),
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-6',
    });

    expect(result).toMatchObject({
      outcome: 'provider_rejected',
      reason: 'The destination number is not reachable via Twilio',
      message: { status: 'REJECTED', failureCode: '21614' },
    });
    expect(harness.storedMessage()).toMatchObject({
      status: 'REJECTED',
      failureCode: '21614',
      failureReason: 'The destination number is not reachable via Twilio',
    });
  });

  test('should persist retriable provider errors as failed', async () => {
    harness.transport.sendSms.mockRejectedValueOnce(
      new TwilioMessagesApiError('Too Many Requests', {
        request: {},
        responseStatus: 429,
        responseBody: null,
        responseHeaders: {},
        requestId: 'request-429',
        error: { code: 20429, message: 'Too Many Requests', status: 429 },
      }),
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-429',
    });

    expect(result).toMatchObject({
      outcome: 'provider_failed',
      reason: 'Too Many Requests',
      message: { status: 'FAILED', failureCode: '20429' },
    });
  });

  test('should persist failed transport errors', async () => {
    harness.transport.sendSms.mockRejectedValueOnce(
      new TwilioMessagesTransportError(
        'Twilio Messages API returned invalid JSON',
        {
          request: {
            To: CONTACT_NUMBER,
            From: SENDER_NUMBER,
            Body: 'Hello there',
          },
          responseBody: 'not-json',
          responseStatus: 502,
        },
      ),
    );

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-7',
    });

    expect(result).toMatchObject({
      outcome: 'provider_failed',
      reason: 'Twilio Messages API returned invalid JSON',
    });
    expect(harness.storedMessage()).toMatchObject({
      status: 'FAILED',
      failureCode: 'provider_transport_error',
      failureReason: 'Twilio Messages API returned invalid JSON',
    });
  });

  test('should propagate unexpected errors without marking the message failed', async () => {
    harness.transport.sendSms.mockRejectedValueOnce(new TypeError('boom'));

    await expect(
      harness.service.sendSms('user-1', {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        idempotencyKey: 'sms-unexpected',
      }),
    ).rejects.toThrow('boom');

    expect(harness.storedMessage()).toMatchObject({ status: 'PENDING' });
  });

  test('should not mark a message failed when media promotion fails after provider acceptance', async () => {
    harness.mediaService.promotePreparedMediaToMessage.mockRejectedValueOnce(
      new Error('disk full'),
    );

    await expect(
      harness.service.sendMms('user-1', {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Photo',
        attachmentIds: ['prepared-1'],
        idempotencyKey: 'mms-promotion-failure',
      }),
    ).rejects.toThrow('disk full');

    expect(harness.transport.sendMms).toHaveBeenCalledTimes(1);
    expect(harness.storedMessage()).toMatchObject({
      status: 'ACCEPTED',
      failureCode: null,
    });
  });

  test('should return an existing message on idempotent replay and avoid a second provider call', async () => {
    const first = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-8',
    });
    const second = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-8',
    });

    expect(first.outcome).toBe('sent');
    expect(second).toMatchObject({
      outcome: 'deduplicated',
      message: { status: 'ACCEPTED' },
    });
    expect(harness.transport.sendSms).toHaveBeenCalledTimes(1);
  });

  test('should reload the existing message when a duplicate token races on create', async () => {
    harness.setStoredMessage(
      buildStoredMessage({
        status: 'ACCEPTED',
        sentAt: new Date('2026-04-02T12:00:05.000Z'),
      }),
    );

    let findUniqueCallCount = 0;
    harness.messageFindUnique.mockImplementation(async () => {
      findUniqueCallCount += 1;
      return findUniqueCallCount === 1 ? null : harness.storedMessage();
    });
    harness.messageCreate.mockRejectedValueOnce({ code: 'P2002' });

    const result = await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-9',
    });

    expect(result).toMatchObject({
      outcome: 'deduplicated',
      message: { status: 'ACCEPTED' },
    });
    expect(harness.transport.sendSms).not.toHaveBeenCalled();
  });

  test('should never log phone numbers or message bodies', async () => {
    await harness.service.sendSms('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Hello there',
      idempotencyKey: 'sms-log',
    });

    const logged = JSON.stringify([
      ...harness.log.info.mock.calls,
      ...harness.log.warn.mock.calls,
      ...harness.log.error.mock.calls,
    ]);

    expect(harness.log.info).toHaveBeenCalled();
    expect(logged).not.toContain('5550123');
    expect(logged).not.toContain('5550100');
    expect(logged).not.toContain('Hello there');
  });
});

function createHarness() {
  let storedMessage: ReturnType<typeof buildStoredMessage> | null = null;

  const senderService = {
    getAllowedSmsSender: vi.fn(async () => buildSender({ mmsEnabled: false })),
    getAllowedMmsSender: vi.fn(async () => buildSender({ mmsEnabled: true })),
  };
  const conversationService = {
    getAccessibleRecordForUser: vi.fn(async () => buildConversation()),
    findOrCreateFor: vi.fn(async () => buildConversation()),
  };
  const mediaService = {
    getPreparedMediaForSend: vi.fn(async () => ({
      id: 'prepared-1',
      publicUrl: 'https://api.example.com/media/prepared-1',
      mimeType: 'image/png',
      fileName: 'image.png',
      sizeBytes: 128_000,
      expiresAt: new Date('2026-04-06T13:00:00.000Z'),
      uploadedAt: new Date('2026-04-06T12:00:00.000Z'),
      consumedAt: null,
    })),
    promotePreparedMediaToMessage: vi.fn(async () => {
      if (storedMessage) {
        storedMessage = buildStoredMessage({
          ...storedMessage,
          channel: 'MMS',
          attachments: [
            {
              id: 'media-1',
              storageUrl: 'https://api.example.com/media/messages/media-1',
              originalUrl: null,
              mimeType: 'image/png',
              fileName: 'image.png',
              sizeBytes: 128_000,
              createdAt: new Date('2026-04-06T12:00:01.000Z'),
            },
          ],
        });
      }

      return {};
    }),
  };
  const transport = {
    sendSms: vi.fn(async () => buildAccepted('SMS')),
    sendMms: vi.fn(async () => buildAccepted('MMS')),
  };
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const messageFindUnique = vi.fn(async () => storedMessage);
  const messageFindUniqueOrThrow = vi.fn(async () => {
    if (!storedMessage) {
      throw new Error('Message not found');
    }
    return storedMessage;
  });
  const messageCreate = vi.fn(async ({ data }) => {
    storedMessage = buildStoredMessage({
      conversationId: data.conversationId,
      status: data.status,
      body: data.body,
      from: data.from,
      to: data.to,
      channel: data.channel,
      failureCode: data.failureCode ?? null,
      failureReason: data.failureReason ?? null,
      failedAt: data.failedAt ?? null,
    });

    return storedMessage;
  });
  const messageUpdate = vi.fn(async ({ data }) => {
    if (!storedMessage) {
      throw new Error('Message not found');
    }

    storedMessage = buildStoredMessage({
      ...storedMessage,
      status:
        ('status' in data ? data.status : storedMessage.status) ??
        storedMessage.status,
      failureCode:
        'failureCode' in data
          ? (data.failureCode ?? null)
          : storedMessage.failureCode,
      failureReason:
        'failureReason' in data
          ? (data.failureReason ?? null)
          : storedMessage.failureReason,
      sentAt: 'sentAt' in data ? (data.sentAt ?? null) : storedMessage.sentAt,
      failedAt:
        'failedAt' in data ? (data.failedAt ?? null) : storedMessage.failedAt,
    });

    return storedMessage;
  });
  const messageConversationUpdate = vi.fn(async () => ({}));
  const messageSuppressionFindFirst = vi.fn(async () => null);

  const transaction = {
    message: {
      findUnique: messageFindUnique,
      create: messageCreate,
      update: messageUpdate,
    },
    messageConversation: {
      update: messageConversationUpdate,
    },
    messageSuppression: {
      findFirst: messageSuppressionFindFirst,
    },
  };
  const db = {
    $transaction: async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    message: {
      findUnique: messageFindUnique,
      findUniqueOrThrow: messageFindUniqueOrThrow,
      update: messageUpdate,
    },
  } as unknown as PrismaClient;

  const service = new MessageSendService({
    db,
    transport: transport as never,
    senderService: senderService as never,
    conversationService: conversationService as never,
    mediaService: mediaService as never,
    log,
  });

  return {
    service,
    senderService,
    conversationService,
    mediaService,
    transport,
    log,
    messageFindUnique,
    messageCreate,
    messageUpdate,
    messageSuppressionFindFirst,
    storedMessage: () => storedMessage,
    setStoredMessage: (message: ReturnType<typeof buildStoredMessage>) => {
      storedMessage = message;
    },
  };
}

function buildSender(overrides: { mmsEnabled: boolean }) {
  return {
    id: 'phone-1',
    phoneNumber: SENDER_NUMBER,
    label: 'Support',
    isPrimary: true,
    smsEnabled: true,
    mmsEnabled: overrides.mmsEnabled,
    userId: 'user-1',
    departmentId: null,
  };
}

function buildConversation(
  overrides: Partial<{
    id: string;
    contactId: string;
    sourcePhoneNumberId: string;
    userId: string | null;
    departmentId: string | null;
    contact: { id: string; name: string | null; phoneNumber: string };
    sourcePhoneNumber: { id: string; phoneNumber: string; label: string };
  }> = {},
) {
  return {
    id: 'conversation-1',
    contactId: 'contact-1',
    sourcePhoneNumberId: 'phone-1',
    userId: 'user-1',
    departmentId: null,
    contact: {
      id: 'contact-1',
      name: null,
      phoneNumber: CONTACT_NUMBER,
    },
    sourcePhoneNumber: {
      id: 'phone-1',
      phoneNumber: SENDER_NUMBER,
      label: 'Support',
    },
    ...overrides,
  };
}

function buildAccepted(channel: 'SMS' | 'MMS') {
  const sid =
    channel === 'SMS'
      ? 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      : 'MMbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  return {
    outcome: 'accepted' as const,
    provider: 'TWILIO' as const,
    channel,
    providerMessageId: sid,
    clientReference: channel === 'SMS' ? 'sms-1' : 'mms-1',
    requestId: 'request-1',
    request: {
      To: CONTACT_NUMBER,
      From: SENDER_NUMBER,
      StatusCallback: 'https://api.example.com/webhooks/twilio/messages/status',
    },
    response: {
      sid,
      status: 'queued',
    },
    responseHeaders: {
      'twilio-request-id': 'request-1',
    },
  };
}

function buildStoredMessage(
  overrides: Partial<{
    id: string;
    conversationId: string;
    status:
      | 'RECEIVED'
      | 'PENDING'
      | 'ACCEPTED'
      | 'DELIVERED'
      | 'FAILED'
      | 'REJECTED'
      | 'EXPIRED'
      | 'BUFFERED'
      | 'UNKNOWN';
    body: string | null;
    from: string;
    to: string;
    failureCode: string | null;
    failureReason: string | null;
    sentAt: Date | null;
    failedAt: Date | null;
    channel: 'SMS' | 'MMS';
    attachments: Array<{
      id: string;
      storageUrl: string;
      originalUrl: string | null;
      mimeType: string;
      fileName: string | null;
      sizeBytes: number | null;
      createdAt: Date;
    }>;
  }> = {},
) {
  return {
    id: overrides.id ?? 'message-1',
    conversationId: overrides.conversationId ?? 'conversation-1',
    direction: 'OUTBOUND' as const,
    channel: overrides.channel ?? ('SMS' as const),
    status: overrides.status ?? 'PENDING',
    body: overrides.body ?? 'Hello there',
    from: overrides.from ?? SENDER_NUMBER,
    to: overrides.to ?? CONTACT_NUMBER,
    failureCode: overrides.failureCode ?? null,
    failureReason: overrides.failureReason ?? null,
    sentAt: overrides.sentAt ?? null,
    deliveredAt: null,
    failedAt: overrides.failedAt ?? null,
    createdAt: new Date('2026-04-02T12:00:00.000Z'),
    attachments: overrides.attachments ?? [],
  };
}
