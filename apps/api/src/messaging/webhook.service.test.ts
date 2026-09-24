import type { PrismaClient } from '@repo/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MessageConversationSendRecord } from './conversation.service.js';
import { MessageWebhookService } from './webhook.service.js';

const CONTACT_NUMBER = '+15555550123';
const SENDER_NUMBER = '+15555550100';
const MESSAGE_SID = 'SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEDUPE_KEY_CONSTRAINT = 'message_provider_events_dedupe_key_key';
const CONTACT_CONSTRAINT = 'contacts_phone_number_key';

/** A P2002 in the shape the pg driver adapter and Prisma 7 produce. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: {
      driverAdapterError: Object.assign(new Error('duplicate key value'), {
        cause: {
          kind: 'UniqueConstraintViolation',
          constraint: { index: constraint },
        },
      }),
    },
  });
}

describe('MessageWebhookService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  test('should persist a valid inbound SMS webhook', async () => {
    const result = await harness.service.processInboundEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.messageProviderEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'INBOUND',
          dedupeKey: `inbound:${MESSAGE_SID}`,
        }),
      }),
    );
    expect(harness.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: 'INBOUND',
          channel: 'SMS',
          status: 'RECEIVED',
          providerMessageId: MESSAGE_SID,
        }),
      }),
    );
    expect(harness.messageConversationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unreadCount: {
            increment: 1,
          },
        }),
      }),
    );
    expect(harness.messageSuppressionUpsert).not.toHaveBeenCalled();
    expect(harness.messageSuppressionUpdateMany).not.toHaveBeenCalled();
  });

  test('should file an inbound message with the line as it found it', async () => {
    // The owner is the one this transaction read; the thread is found from
    // that reading and not from a second one that could disagree with it.
    const line = { id: 'phone-1', userId: null, departmentId: 'dept-1' };
    harness.phoneNumberFindFirst.mockResolvedValueOnce(line);

    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

    expect(harness.conversationService.findOrCreateFor).toHaveBeenCalledWith(
      CONTACT_NUMBER,
      line,
      expect.any(Object),
    );
  });

  test('should quarantine inbound messages for unknown destination numbers', async () => {
    harness.phoneNumberFindFirst.mockResolvedValueOnce(null);

    const result = await harness.service.processInboundEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'quarantined' });
    expect(harness.messageCreate).not.toHaveBeenCalled();
    expect(harness.messageProviderEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingState: 'QUARANTINED',
          processingError: 'Unknown or inactive destination number',
        }),
      }),
    );
  });

  test('should say why when it quarantines a message to an active number nobody holds', async () => {
    // The number is known and active in the admin console, so the stored
    // reason, the only trail such a message leaves, must not call it unknown.
    harness.phoneNumberFindFirst.mockResolvedValueOnce({
      id: 'phone-1',
      userId: null,
      departmentId: null,
    });

    const result = await harness.service.processInboundEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'quarantined' });
    expect(harness.conversationService.findOrCreateFor).not.toHaveBeenCalled();
    expect(harness.messageCreate).not.toHaveBeenCalled();
    expect(harness.messageProviderEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingState: 'QUARANTINED',
          processingError: 'Destination number has no owner',
        }),
      }),
    );
    expect(harness.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ toLastFour: '0100' }),
      'Quarantined inbound message for a destination number nobody holds',
    );
  });

  test('should treat duplicate inbound webhooks as already processed', async () => {
    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });
    harness.messageCreate.mockClear();

    const result = await harness.service.processInboundEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'deduplicated' });
    expect(harness.messageCreate).not.toHaveBeenCalled();
  });

  test('should store the message after another delivery created the contact first', async () => {
    // Two messages from a number nobody has texted before arrive together and
    // both transactions try to create the contact. The loser rolled back and
    // stored nothing, so it has to run again instead of reporting a duplicate.
    harness.conversationService.findOrCreateFor.mockRejectedValueOnce(
      uniqueViolation(CONTACT_CONSTRAINT),
    );

    const result = await harness.service.processInboundEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.conversationService.findOrCreateFor).toHaveBeenCalledTimes(
      2,
    );
    expect(harness.messageCreate).toHaveBeenCalledTimes(1);
  });

  test('should fail loudly when the second attempt loses the race too', async () => {
    harness.conversationService.findOrCreateFor.mockRejectedValue(
      uniqueViolation(CONTACT_CONSTRAINT),
    );

    await expect(
      harness.service.processInboundEvent({ MessageSid: 'SMignored' }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(harness.messageCreate).not.toHaveBeenCalled();
  });

  test('should not swallow an unrelated write failure', async () => {
    harness.conversationService.findOrCreateFor.mockRejectedValueOnce(
      new Error('connection terminated'),
    );

    await expect(
      harness.service.processInboundEvent({ MessageSid: 'SMignored' }),
    ).rejects.toThrow('connection terminated');
    expect(harness.conversationService.findOrCreateFor).toHaveBeenCalledTimes(
      1,
    );
  });

  test('should create a suppression record when the provider flags a STOP keyword', async () => {
    harness.transport.normalizeInboundEvent.mockReturnValueOnce(
      buildInboundEvent({ keyword: 'STOP', body: 'STOP' }),
    );

    const result = await harness.service.processInboundEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.messageSuppressionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contactId_sourcePhoneNumberId: {
            contactId: 'contact-1',
            sourcePhoneNumberId: 'phone-1',
          },
        },
        update: expect.objectContaining({
          keyword: 'STOP',
          releasedAt: null,
        }),
      }),
    );
  });

  test.each(['stop', ' Unsubscribe ', 'QUIT'])(
    'should suppress when the body is exactly the keyword %j and the provider did not flag it',
    async (body) => {
      harness.transport.normalizeInboundEvent.mockReturnValueOnce(
        buildInboundEvent({ keyword: null, body }),
      );

      await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

      expect(harness.messageSuppressionUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            keyword: body.trim().toUpperCase(),
          }),
        }),
      );
    },
  );

  test('should not suppress when a keyword is part of a longer message', async () => {
    harness.transport.normalizeInboundEvent.mockReturnValueOnce(
      buildInboundEvent({ keyword: null, body: 'please stop calling' }),
    );

    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

    expect(harness.messageSuppressionUpsert).not.toHaveBeenCalled();
    expect(harness.messageSuppressionUpdateMany).not.toHaveBeenCalled();
  });

  test('should release the suppression when the provider flags a START keyword', async () => {
    harness.transport.normalizeInboundEvent.mockReturnValueOnce(
      buildInboundEvent({ keyword: 'START', body: 'START' }),
    );

    const result = await harness.service.processInboundEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.messageSuppressionUpdateMany).toHaveBeenCalledWith({
      where: {
        contactId: 'contact-1',
        sourcePhoneNumberId: 'phone-1',
        releasedAt: null,
      },
      data: { releasedAt: new Date('2026-04-06T12:00:00.000Z') },
    });
    expect(harness.messageSuppressionUpsert).not.toHaveBeenCalled();
  });

  test.each(['yes', 'Unstop'])(
    'should release the suppression when the body is exactly %j',
    async (body) => {
      harness.transport.normalizeInboundEvent.mockReturnValueOnce(
        buildInboundEvent({ keyword: null, body }),
      );

      await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

      expect(harness.messageSuppressionUpdateMany).toHaveBeenCalledTimes(1);
    },
  );

  test('should ingest inbound MMS media metadata', async () => {
    harness.transport.normalizeInboundEvent.mockReturnValueOnce(
      buildInboundEvent({
        channel: 'MMS',
        body: 'Photo',
        media: [
          {
            url: 'https://provider.example.com/media/1',
            mimeType: 'image/png',
            fileName: 'photo.png',
          },
        ],
      }),
    );

    const result = await harness.service.processInboundEvent({
      MessageSid: 'MMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channel: 'MMS',
        }),
      }),
    );
    expect(harness.mediaService.ingestInboundMedia).toHaveBeenCalledWith(
      'message-1',
      [
        {
          url: 'https://provider.example.com/media/1',
          mimeType: 'image/png',
          fileName: 'photo.png',
        },
      ],
    );
  });

  test('should swallow inbound media ingestion failures after message persistence', async () => {
    harness.transport.normalizeInboundEvent.mockReturnValueOnce(
      buildInboundEvent({
        channel: 'MMS',
        media: [
          {
            url: 'https://provider.example.com/media/2',
            mimeType: 'image/png',
            fileName: 'photo.png',
          },
        ],
      }),
    );
    harness.mediaService.ingestInboundMedia.mockRejectedValueOnce(
      new Error('download failed'),
    );

    const result = await harness.service.processInboundEvent({
      MessageSid: 'MMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.messageCreate).toHaveBeenCalled();
    expect(harness.log.warn).toHaveBeenCalled();
  });

  test('should persist a valid status webhook', async () => {
    const result = await harness.service.processStatusEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.messageProviderEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'STATUS',
          dedupeKey: `status:${MESSAGE_SID}:delivered`,
        }),
      }),
    );
    expect(harness.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DELIVERED',
          deliveredAt: new Date('2026-04-06T12:00:05.000Z'),
        }),
      }),
    );
    expect(harness.messageProviderEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingState: 'PROCESSED',
          messageId: 'message-1',
        }),
      }),
    );
  });

  test('should include the error code in the status dedupe key', async () => {
    harness.transport.normalizeStatusEvent.mockReturnValueOnce(
      buildStatusEvent({
        providerStatus: 'undeliverable',
        errorCode: '30003',
        errorText: 'Unreachable destination handset',
      }),
    );

    await harness.service.processStatusEvent({ MessageSid: 'SMignored' });

    expect(harness.messageProviderEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: `status:${MESSAGE_SID}:undeliverable:30003`,
        }),
      }),
    );
    expect(harness.messageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          failureCode: '30003',
          failureReason: 'Unreachable destination handset',
        }),
      }),
    );
  });

  test('should deduplicate a retried status callback', async () => {
    const first = await harness.service.processStatusEvent({
      MessageSid: 'SMignored',
    });
    const retry = await harness.service.processStatusEvent({
      MessageSid: 'SMignored',
    });

    expect(first).toEqual({ outcome: 'processed' });
    expect(retry).toEqual({ outcome: 'deduplicated' });
    expect(harness.messageUpdate).toHaveBeenCalledTimes(1);
  });

  test('should not report a status write that lost another unique key as a duplicate', async () => {
    harness.messageUpdate.mockRejectedValueOnce(
      uniqueViolation('messages_provider_message_id_key'),
    );

    await expect(
      harness.service.processStatusEvent({ MessageSid: 'SMignored' }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  test('should mark unknown status callbacks as orphaned', async () => {
    harness.messageFindUnique.mockResolvedValueOnce(null);

    const result = await harness.service.processStatusEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'orphaned' });
    expect(harness.messageUpdate).not.toHaveBeenCalled();
    expect(harness.messageProviderEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingState: 'ORPHANED',
        }),
      }),
    );
  });

  test('should not move a delivered message backward', async () => {
    harness.transport.normalizeStatusEvent.mockReturnValueOnce(
      buildStatusEvent({
        providerStatus: 'submitted',
      }),
    );
    harness.messageFindUnique.mockResolvedValueOnce({
      id: 'message-1',
      conversationId: 'conversation-1',
      status: 'DELIVERED',
    });

    const result = await harness.service.processStatusEvent({
      MessageSid: 'SMignored',
    });

    expect(result).toEqual({ outcome: 'processed' });
    expect(harness.messageUpdate).not.toHaveBeenCalled();
  });

  test('should tell the browsers about a stored inbound message', async () => {
    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

    expect(harness.activity.notify).toHaveBeenCalledWith(
      'conversation-1',
      'received',
    );
  });

  test('should tell the browsers only once the attachments are in', async () => {
    const order: string[] = [];
    harness.transport.normalizeInboundEvent.mockReturnValueOnce(
      buildInboundEvent({
        media: [
          {
            url: 'https://example.com/media/1',
            mimeType: null,
            fileName: null,
          },
        ],
      }),
    );
    harness.mediaService.ingestInboundMedia.mockImplementationOnce(async () => {
      order.push('media');
    });
    harness.activity.notify.mockImplementationOnce(async () => {
      order.push('notify');
    });

    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

    expect(order).toEqual(['media', 'notify']);
  });

  test('should say nothing about a message for a number that is not ours', async () => {
    harness.phoneNumberFindFirst.mockResolvedValueOnce(null);

    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

    expect(harness.activity.notify).not.toHaveBeenCalled();
  });

  test('should say nothing the second time the same message is delivered', async () => {
    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });
    expect(harness.activity.notify).toHaveBeenCalledTimes(1);

    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });

    expect(harness.activity.notify).toHaveBeenCalledTimes(1);
  });

  test('should tell the browsers about a delivery status that was applied', async () => {
    await harness.service.processStatusEvent({ MessageSid: 'SMignored' });

    expect(harness.activity.notify).toHaveBeenCalledWith(
      'conversation-1',
      'status',
    );
  });

  test('should say nothing about a status that changed nothing', async () => {
    harness.transport.normalizeStatusEvent.mockReturnValueOnce(
      buildStatusEvent({ providerStatus: 'submitted' }),
    );
    harness.messageFindUnique.mockResolvedValueOnce({
      id: 'message-1',
      conversationId: 'conversation-1',
      status: 'DELIVERED',
    });

    await harness.service.processStatusEvent({ MessageSid: 'SMignored' });

    expect(harness.activity.notify).not.toHaveBeenCalled();
  });

  test('should say nothing about an orphaned status callback', async () => {
    harness.messageFindUnique.mockResolvedValueOnce(null);

    await harness.service.processStatusEvent({ MessageSid: 'SMignored' });

    expect(harness.activity.notify).not.toHaveBeenCalled();
  });

  test('should never log phone numbers or message bodies', async () => {
    harness.phoneNumberFindFirst.mockResolvedValueOnce(null);
    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });
    await harness.service.processInboundEvent({ MessageSid: 'SMignored' });
    await harness.service.processStatusEvent({ MessageSid: 'SMignored' });

    const logged = JSON.stringify([
      ...harness.log.info.mock.calls,
      ...harness.log.warn.mock.calls,
    ]);

    expect(harness.log.info).toHaveBeenCalled();
    expect(harness.log.warn).toHaveBeenCalled();
    expect(logged).not.toContain('5555550123');
    expect(logged).not.toContain('5555550100');
    expect(logged).not.toContain('Hello there');
  });
});

function createHarness() {
  const seenDedupeKeys = new Set<string>();
  /** Keys written by the transaction in flight, undone when it rolls back. */
  let uncommittedDedupeKeys: string[] = [];

  const transport = {
    normalizeInboundEvent: vi.fn(() => buildInboundEvent()),
    normalizeStatusEvent: vi.fn(() => buildStatusEvent()),
  };
  const conversationService = {
    findOrCreateFor: vi.fn(
      async (): Promise<MessageConversationSendRecord> => ({
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
          userId: 'user-1',
          departmentId: null,
        },
      }),
    ),
  };
  const mediaService = {
    ingestInboundMedia: vi.fn(async () => {}),
  };
  const activity = {
    notify: vi.fn(async () => {}),
  };
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  const messageProviderEventCreate = vi.fn(
    async ({ data }: { data: { dedupeKey: string } }) => {
      if (seenDedupeKeys.has(data.dedupeKey)) {
        throw uniqueViolation(DEDUPE_KEY_CONSTRAINT);
      }
      seenDedupeKeys.add(data.dedupeKey);
      uncommittedDedupeKeys.push(data.dedupeKey);
      return { id: 'event-1' };
    },
  );
  const messageProviderEventUpdate = vi.fn(async () => ({}));
  const phoneNumberFindFirst = vi.fn(
    async (): Promise<{
      id: string;
      userId: string | null;
      departmentId: string | null;
    } | null> => ({ id: 'phone-1', userId: 'user-1', departmentId: null }),
  );
  const messageCreate = vi.fn(async () => ({
    id: 'message-1',
    conversationId: 'conversation-1',
    createdAt: new Date('2026-04-06T12:00:00.000Z'),
  }));
  const messageConversationUpdate = vi.fn(async () => ({}));
  const messageSuppressionUpsert = vi.fn(async () => ({}));
  const messageSuppressionUpdateMany = vi.fn(async () => ({ count: 1 }));
  const messageFindUnique = vi.fn(async () => ({
    id: 'message-1',
    conversationId: 'conversation-1',
    status: 'ACCEPTED',
  }));
  const messageUpdate = vi.fn(async () => ({}));

  const transaction = {
    messageProviderEvent: {
      create: messageProviderEventCreate,
      update: messageProviderEventUpdate,
    },
    phoneNumber: {
      findFirst: phoneNumberFindFirst,
    },
    message: {
      create: messageCreate,
      findUnique: messageFindUnique,
      update: messageUpdate,
    },
    messageConversation: {
      update: messageConversationUpdate,
    },
    messageSuppression: {
      upsert: messageSuppressionUpsert,
      updateMany: messageSuppressionUpdateMany,
    },
  };

  const service = new MessageWebhookService({
    db: {
      /* Rolls the dedupe keys back on failure, as the database would. */
      $transaction: async (callback: (tx: typeof transaction) => unknown) => {
        uncommittedDedupeKeys = [];

        try {
          return await callback(transaction);
        } catch (error) {
          for (const key of uncommittedDedupeKeys) {
            seenDedupeKeys.delete(key);
          }

          throw error;
        }
      },
    } as unknown as PrismaClient,
    transport: transport as never,
    conversationService: conversationService as never,
    mediaService: mediaService as never,
    activity,
    log,
  });

  return {
    service,
    transport,
    conversationService,
    mediaService,
    activity,
    log,
    messageProviderEventCreate,
    messageProviderEventUpdate,
    phoneNumberFindFirst,
    messageCreate,
    messageConversationUpdate,
    messageSuppressionUpsert,
    messageSuppressionUpdateMany,
    messageFindUnique,
    messageUpdate,
  };
}

function buildInboundEvent(
  overrides: Partial<ReturnType<typeof buildInboundEventBase>> = {},
) {
  return {
    ...buildInboundEventBase(),
    ...overrides,
  };
}

function buildInboundEventBase() {
  return {
    provider: 'TWILIO' as const,
    channel: 'SMS' as const,
    providerMessageId: MESSAGE_SID,
    providerTimestamp: '2026-04-06T12:00:00.000Z',
    from: CONTACT_NUMBER,
    to: SENDER_NUMBER,
    body: 'Hello there',
    keyword: null as string | null,
    media: [] as Array<{
      url: string;
      mimeType: string | null;
      fileName: string | null;
    }>,
    rawPayload: {
      channel: 'sms',
    },
  };
}

function buildStatusEvent(
  overrides: Partial<ReturnType<typeof buildStatusEventBase>> = {},
) {
  return {
    ...buildStatusEventBase(),
    ...overrides,
  };
}

function buildStatusEventBase() {
  return {
    provider: 'TWILIO' as const,
    channel: 'SMS' as const,
    providerMessageId: MESSAGE_SID,
    providerTimestamp: '2026-04-06T12:00:05.000Z',
    from: SENDER_NUMBER,
    to: CONTACT_NUMBER,
    providerStatus: 'delivered' as
      | 'submitted'
      | 'delivered'
      | 'rejected'
      | 'undeliverable',
    clientReference: 'sms-1',
    errorCode: null as string | null,
    errorText: null as string | null,
    errorType: null as string | null,
    rawPayload: {
      channel: 'sms',
    },
  };
}
