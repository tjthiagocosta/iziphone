import type { PrismaClient } from '@repo/db';
import { CHANNELS, type ChannelInput } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CallEventSubscriberService } from './call-event-subscriber.js';

type MessageListener = (channel: string, message: string) => void;

const timestamp = '2026-03-20T10:00:00.000Z';
const from = '+15555550101';
const to = '+15555550102';
const transcript = 'Please call me back about my order.';

const storedCall = {
  id: 'call-1',
  callerLegUuid: 'caller-leg',
  agentLegUuid: 'agent-leg',
  externalLegUuid: null,
};

function createHarness() {
  let listener: MessageListener | undefined;
  const subscribe = vi.fn(async () => undefined);
  const quit = vi.fn(async () => 'OK');
  const connection = {
    subscribe,
    quit,
    on: (_event: 'message', next: MessageListener) => {
      listener = next;
    },
  };
  const redis = { duplicate: () => connection } as unknown as Redis;

  const db = {
    call: {
      upsert: vi.fn(async () => ({ id: 'call-1' })),
      update: vi.fn(async () => ({ id: 'call-1' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async (): Promise<unknown> => storedCall),
    },
    callEvent: {
      create: vi.fn(async () => ({ id: 'event-1' })),
    },
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const service = new CallEventSubscriberService(
    redis,
    db as unknown as PrismaClient,
    logger as unknown as FastifyBaseLogger,
  );

  const emit = async (channel: string, payload: unknown) => {
    if (!listener) throw new Error('subscriber not started');
    listener(channel, JSON.stringify(payload));
    // Handlers run asynchronously; let their (already resolved) awaits settle.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  return { service, db, logger, subscribe, quit, emit };
}

describe('CallEventSubscriberService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(async () => {
    harness = createHarness();
    await harness.service.start();
  });

  test('subscribes to every call event channel on a dedicated connection', () => {
    expect(harness.subscribe).toHaveBeenCalledWith(
      CHANNELS.CALL_INCOMING,
      CHANNELS.CALL_STARTED,
      CHANNELS.CALL_ENDED,
      CHANNELS.CALL_MISSED,
      CHANNELS.CALL_TRANSFERRED,
      CHANNELS.CALL_HELD,
      CHANNELS.CALL_RESUMED,
      CHANNELS.CALL_PARTICIPANT_STATUS,
      CHANNELS.CALL_RECORDING_READY,
      CHANNELS.CALL_TRANSCRIPTION_READY,
      CHANNELS.CALL_CONVERSATION_MIGRATED,
    );
  });

  test('records an incoming call and its ringing timeline entry', async () => {
    const event: ChannelInput<'call:incoming'> = {
      conversationUuid: 'conv-1',
      from,
      to,
      callerLegUuid: 'caller-leg',
      departmentId: 'dept-1',
      timestamp,
    };

    await harness.emit(CHANNELS.CALL_INCOMING, event);

    expect(harness.db.call.upsert).toHaveBeenCalledWith({
      where: { conversationUuid: 'conv-1' },
      create: {
        conversationUuid: 'conv-1',
        callerLegUuid: 'caller-leg',
        agentLegUuid: undefined,
        from,
        to,
        direction: 'inbound',
        status: 'ringing',
        departmentId: 'dept-1',
        userId: null,
      },
      update: {
        callerLegUuid: 'caller-leg',
        agentLegUuid: undefined,
        from,
        to,
        direction: 'inbound',
        departmentId: 'dept-1',
        userId: null,
      },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        callId: 'call-1',
        eventType: 'CALL_RINGING',
        actorType: 'CALLER',
        actorId: from,
      }),
    });
  });

  test('records an outbound dial as agent-initiated', async () => {
    const event: ChannelInput<'call:incoming'> = {
      conversationUuid: 'conv-2',
      from,
      to,
      direction: 'outbound',
      userId: 'user-1',
      timestamp,
    };

    await harness.emit(CHANNELS.CALL_INCOMING, event);

    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'DIAL_INITIATED',
        actorType: 'AGENT',
        actorId: 'user-1',
      }),
    });
  });

  test('marks an answered call in progress', async () => {
    const event: ChannelInput<'call:started'> = {
      conversationUuid: 'conv-1',
      from,
      to,
      userId: 'user-1',
      direction: 'inbound',
      agentLegUuid: 'agent-leg',
      timestamp,
    };

    await harness.emit(CHANNELS.CALL_STARTED, event);

    expect(harness.db.call.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationUuid: 'conv-1' },
        update: expect.objectContaining({
          status: 'in-progress',
          userId: 'user-1',
          agentLegUuid: 'agent-leg',
        }),
      }),
    );
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        callId: 'call-1',
        eventType: 'CALL_ANSWERED',
        actorType: 'AGENT',
        actorId: 'user-1',
      }),
    });
  });

  test('closes a call with its final status and keeps known legs', async () => {
    const event: ChannelInput<'call:ended'> = {
      conversationUuid: 'conv-1',
      duration: 42,
      status: 'busy',
      timestamp,
    };

    await harness.emit(CHANNELS.CALL_ENDED, event);

    expect(harness.db.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: {
        status: 'busy',
        duration: 42,
        callerLegUuid: 'caller-leg',
        agentLegUuid: 'agent-leg',
        externalLegUuid: null,
      },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'CALL_BUSY',
        actorType: 'PROVIDER',
      }),
    });
  });

  test('skips an ended event for an unknown call', async () => {
    harness.db.call.findUnique.mockResolvedValue(null);

    await harness.emit(CHANNELS.CALL_ENDED, {
      conversationUuid: 'conv-unknown',
      duration: 1,
      status: 'completed',
      timestamp,
    } satisfies ChannelInput<'call:ended'>);

    expect(harness.db.call.update).not.toHaveBeenCalled();
    expect(harness.db.callEvent.create).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      { conversationUuid: 'conv-unknown' },
      'No call record for event',
    );
  });

  test('records a missed call', async () => {
    await harness.emit(CHANNELS.CALL_MISSED, {
      conversationUuid: 'conv-3',
      from,
      departmentId: 'dept-1',
      timestamp,
    } satisfies ChannelInput<'call:missed'>);

    expect(harness.db.call.upsert).toHaveBeenCalledWith({
      where: { conversationUuid: 'conv-3' },
      create: {
        conversationUuid: 'conv-3',
        from,
        to: '',
        direction: 'inbound',
        status: 'missed',
        departmentId: 'dept-1',
        userId: null,
      },
      update: { status: 'missed' },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'CALL_NO_ANSWER',
        actorType: 'SYSTEM',
      }),
    });
  });

  test('reassigns a transferred call', async () => {
    await harness.emit(CHANNELS.CALL_TRANSFERRED, {
      conversationUuid: 'conv-1',
      fromUserId: 'user-1',
      toUserId: 'user-2',
      timestamp,
    } satisfies ChannelInput<'call:transferred'>);

    expect(harness.db.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { userId: 'user-2', agentLegUuid: 'agent-leg' },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'CALL_TRANSFERRED',
        actorId: 'user-1',
        metadata: expect.objectContaining({ toUserId: 'user-2' }),
      }),
    });
  });

  test('a transferred call belongs to the teammate and their leg, with the handover on the timeline', async () => {
    await harness.emit(CHANNELS.CALL_TRANSFERRED, {
      conversationUuid: 'conv-1',
      fromUserId: 'user-1',
      toUserId: 'user-2',
      agentLegUuid: 'teammate-leg',
      timestamp,
    } satisfies ChannelInput<'call:transferred'>);

    expect(harness.db.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { userId: 'user-2', agentLegUuid: 'teammate-leg' },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: {
        callId: 'call-1',
        eventType: 'CALL_TRANSFERRED',
        actorType: 'AGENT',
        actorId: 'user-1',
        description: 'Call transferred to another agent',
        metadata: {
          fromUserId: 'user-1',
          toUserId: 'user-2',
          agentLegUuid: 'teammate-leg',
        },
      },
    });
  });

  test('writes a timeline entry when the agent holds the call and when they resume it', async () => {
    const event = {
      conversationUuid: 'conv-1',
      userId: 'user-1',
      legUuid: 'caller-leg',
      timestamp,
    } satisfies ChannelInput<'call:held'>;

    await harness.emit(CHANNELS.CALL_HELD, event);
    await harness.emit(CHANNELS.CALL_RESUMED, event);

    expect(harness.db.callEvent.create.mock.calls).toEqual([
      [
        {
          data: {
            callId: 'call-1',
            eventType: 'CALL_HELD',
            actorType: 'AGENT',
            actorId: 'user-1',
            description: 'Call placed on hold',
            metadata: { legUuid: 'caller-leg' },
          },
        },
      ],
      [
        {
          data: {
            callId: 'call-1',
            eventType: 'CALL_RESUMED',
            actorType: 'AGENT',
            actorId: 'user-1',
            description: 'Call taken off hold',
            metadata: { legUuid: 'caller-leg' },
          },
        },
      ],
    ]);
    expect(harness.db.call.update).not.toHaveBeenCalled();
  });

  test('a resume nobody asked for, after a transfer settled, is the system’s', async () => {
    await harness.emit(CHANNELS.CALL_RESUMED, {
      conversationUuid: 'conv-1',
      legUuid: 'caller-leg',
      timestamp,
    } satisfies ChannelInput<'call:resumed'>);

    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'CALL_RESUMED',
        actorType: 'SYSTEM',
        actorId: undefined,
      }),
    });
  });

  test('drops a hold for a call it has no record of', async () => {
    harness.db.call.findUnique.mockResolvedValue(null);

    await harness.emit(CHANNELS.CALL_HELD, {
      conversationUuid: 'conv-9',
      userId: 'user-1',
      timestamp,
    } satisfies ChannelInput<'call:held'>);

    expect(harness.db.callEvent.create).not.toHaveBeenCalled();
  });

  test('adds a participant status entry with a known event type', async () => {
    await harness.emit(CHANNELS.CALL_PARTICIPANT_STATUS, {
      conversationUuid: 'conv-1',
      participantType: 'caller',
      participantId: from,
      status: 'on-hold',
      eventType: 'CALL_HELD',
      description: 'Caller placed on hold',
      timestamp,
    } satisfies ChannelInput<'call:participant-status'>);

    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        callId: 'call-1',
        eventType: 'CALL_HELD',
        actorType: 'CALLER',
        actorId: from,
      }),
    });
  });

  test('drops a participant status with an unknown event type', async () => {
    await harness.emit(CHANNELS.CALL_PARTICIPANT_STATUS, {
      conversationUuid: 'conv-1',
      participantType: 'agent',
      participantId: 'user-1',
      status: 'weird',
      eventType: 'NOT_A_REAL_EVENT',
      description: 'Something new',
      timestamp,
    } satisfies ChannelInput<'call:participant-status'>);

    expect(harness.db.callEvent.create).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      { conversationUuid: 'conv-1', eventType: 'NOT_A_REAL_EVENT' },
      'Dropped participant status with an unknown event type',
    );
  });

  test('stores a voicemail recording and its timeline entry', async () => {
    await harness.emit(CHANNELS.CALL_RECORDING_READY, {
      conversationUuid: 'conv-1',
      recordingUrl: 'https://recordings.example.com/rec-1.mp3',
      duration: 12,
      context: 'voicemail',
      timestamp,
    } satisfies ChannelInput<'call:recording-ready'>);

    expect(harness.db.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { recordingUrl: 'https://recordings.example.com/rec-1.mp3' },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'VOICEMAIL_COMPLETED' }),
    });
  });

  test('stores a call recording without a voicemail timeline entry', async () => {
    await harness.emit(CHANNELS.CALL_RECORDING_READY, {
      conversationUuid: 'conv-1',
      recordingUrl: 'https://recordings.example.com/rec-2.mp3',
      context: 'call',
      timestamp,
    } satisfies ChannelInput<'call:recording-ready'>);

    expect(harness.db.call.update).toHaveBeenCalled();
    expect(harness.db.callEvent.create).not.toHaveBeenCalled();
  });

  test('stores a transcript without logging it', async () => {
    await harness.emit(CHANNELS.CALL_TRANSCRIPTION_READY, {
      conversationUuid: 'conv-1',
      transcript,
      timestamp,
    } satisfies ChannelInput<'call:transcription-ready'>);

    expect(harness.db.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { transcript },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'VOICEMAIL_COMPLETED' }),
    });
    expect(
      harness.db.callEvent.create.mock.calls[0]?.[0].data.metadata,
    ).not.toHaveProperty('transcript');
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain(
      transcript,
    );
  });

  test('renames a migrated conversation once', async () => {
    harness.db.call.findUnique.mockResolvedValue(null);

    await harness.emit(CHANNELS.CALL_CONVERSATION_MIGRATED, {
      previousConversationUuid: 'conv-old',
      conversationUuid: 'conv-new',
      timestamp,
    } satisfies ChannelInput<'call:conversation-migrated'>);

    expect(harness.db.call.updateMany).toHaveBeenCalledWith({
      where: { conversationUuid: 'conv-old' },
      data: { conversationUuid: 'conv-new' },
    });

    harness.db.call.updateMany.mockClear();
    harness.db.call.findUnique.mockResolvedValue({ id: 'call-1' });

    await harness.emit(CHANNELS.CALL_CONVERSATION_MIGRATED, {
      previousConversationUuid: 'conv-old',
      conversationUuid: 'conv-new',
      timestamp,
    } satisfies ChannelInput<'call:conversation-migrated'>);

    expect(harness.db.call.updateMany).not.toHaveBeenCalled();
  });

  test('never logs phone numbers at info level', async () => {
    await harness.emit(CHANNELS.CALL_INCOMING, {
      conversationUuid: 'conv-1',
      from,
      to,
      timestamp,
    } satisfies ChannelInput<'call:incoming'>);

    const logged = JSON.stringify(harness.logger.info.mock.calls);
    expect(logged).not.toContain(from);
    expect(logged).not.toContain(to);
    expect(harness.logger.info).toHaveBeenCalledWith(
      { channel: CHANNELS.CALL_INCOMING, conversationUuid: 'conv-1' },
      'Received call event',
    );
  });

  test('drops a payload that does not match the channel schema', async () => {
    await harness.emit(CHANNELS.CALL_ENDED, { conversationUuid: 'conv-1' });

    expect(harness.db.call.update).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNELS.CALL_ENDED }),
      'Dropped pub/sub message that does not match the channel schema',
    );
  });

  test('logs a persistence failure with the conversation and keeps running', async () => {
    harness.db.call.upsert.mockRejectedValueOnce(new Error('db down'));

    await harness.emit(CHANNELS.CALL_MISSED, {
      conversationUuid: 'conv-9',
      from,
      timestamp,
    } satisfies ChannelInput<'call:missed'>);

    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: CHANNELS.CALL_MISSED,
        conversationUuid: 'conv-9',
      }),
      'Failed to persist call event',
    );
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain(from);

    await harness.emit(CHANNELS.CALL_MISSED, {
      conversationUuid: 'conv-10',
      from,
      timestamp,
    } satisfies ChannelInput<'call:missed'>);

    expect(harness.db.callEvent.create).toHaveBeenCalledTimes(1);
  });

  test('closes the dedicated connection', async () => {
    await harness.service.close();
    expect(harness.quit).toHaveBeenCalled();
  });
});
