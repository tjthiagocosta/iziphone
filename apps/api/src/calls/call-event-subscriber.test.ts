import { Readable } from 'node:stream';
import type { PrismaClient } from '@repo/db';
import { CHANNELS, type ChannelInput } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { InMemoryMediaStore } from '../media-store/index.js';
import { CallEventSubscriberService } from './call-event-subscriber.js';
import { CallRecordingService } from './recording.service.js';

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

const credentials = {
  accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authToken: 'not-a-real-twilio-token',
};
const recordingSid = 'REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Recordings/${recordingSid}`;
const recordingKey = `recordings/conv-1/${recordingSid}.mp3`;
const audioBytes = Buffer.from('fictional mp3 bytes');
const MEBIBYTE = 1024 * 1024;
const basicAuth = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`;

/** Settles the way `fetch` does once its signal is aborted. */
function abortedBy(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

/**
 * The recording as Twilio serves it: an MP3 whose length it declares, as
 * a stored file's is. `headers` replaces that whole set.
 */
function audio(
  body: BodyInit = audioBytes,
  headers: Record<string, string> = {
    'content-type': 'audio/mpeg',
    'content-length': String(audioBytes.byteLength),
  },
) {
  return new Response(body, { status: 200, headers });
}

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
    callRecording: {
      // The row as Twilio announced it: no copy yet, still at Twilio.
      upsert: vi.fn(
        async (args: {
          where: { recordingSid: string };
          create: { context: string; providerUrl: string };
        }) => ({
          id: 'recording-1',
          context: args.create.context,
          recordingSid: args.where.recordingSid,
          providerUrl: args.create.providerUrl,
          objectKey: null,
          providerDeletedAt: null,
        }),
      ),
      update: vi.fn(async () => ({ id: 'recording-1' })),
    },
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mediaStore = new InMemoryMediaStore();
  /** Twilio as the copy sees it: the MP3 on a GET, 204 on a DELETE. */
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) =>
    init?.method === 'DELETE' ? new Response(null, { status: 204 }) : audio(),
  );
  vi.stubGlobal('fetch', fetchMock);

  const service = new CallEventSubscriberService(
    redis,
    db as unknown as PrismaClient,
    logger as unknown as FastifyBaseLogger,
    new CallRecordingService(
      db as unknown as PrismaClient,
      mediaStore,
      credentials,
      logger,
    ),
  );

  const emit = async (channel: string, payload: unknown) => {
    if (!listener) throw new Error('subscriber not started');
    listener(channel, JSON.stringify(payload));
    // Handlers run asynchronously; let their (already resolved) awaits settle.
    for (let i = 0; i < 25; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  return {
    service,
    db,
    logger,
    mediaStore,
    fetchMock,
    subscribe,
    quit,
    emit,
  };
}

describe('CallEventSubscriberService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(async () => {
    harness = createHarness();
    await harness.service.start();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  test('records an outbound dial on the line it left from, for the agent and the department of the line', async () => {
    const line = '+15555550102';
    const customer = '+15555550199';
    const event: ChannelInput<'call:incoming'> = {
      conversationUuid: 'conv-2',
      from: line,
      to: customer,
      direction: 'outbound',
      agentLegUuid: 'agent-leg',
      departmentId: 'dept-1',
      userId: 'user-1',
      timestamp,
    };

    await harness.emit(CHANNELS.CALL_INCOMING, event);

    // `from` is what the line filter and the thread match on; the agent is
    // the user of the record and the actor of the timeline entry.
    expect(harness.db.call.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          from: line,
          to: customer,
          direction: 'outbound',
          departmentId: 'dept-1',
          userId: 'user-1',
        }),
      }),
    );
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

  describe('recordings', () => {
    function recordingReady(
      overrides: Partial<ChannelInput<'call:recording-ready'>> = {},
    ): ChannelInput<'call:recording-ready'> {
      return {
        conversationUuid: 'conv-1',
        recordingUrl,
        duration: 12,
        context: 'voicemail',
        timestamp,
        ...overrides,
      };
    }

    /** What the copy asked Twilio, in order. */
    function twilioRequests() {
      return harness.fetchMock.mock.calls.map(([url, init]) => ({
        method: init?.method ?? 'GET',
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      }));
    }

    test('records a voicemail recording, copies it into the store and deletes it at Twilio', async () => {
      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      expect(harness.db.callRecording.upsert).toHaveBeenCalledWith({
        where: { recordingSid },
        create: {
          callId: 'call-1',
          context: 'VOICEMAIL',
          recordingSid,
          providerUrl: recordingUrl,
          duration: 12,
        },
        update: {},
        select: expect.any(Object),
      });
      expect(harness.db.callEvent.create).toHaveBeenCalledWith({
        data: {
          callId: 'call-1',
          eventType: 'VOICEMAIL_COMPLETED',
          actorType: 'PROVIDER',
          actorId: undefined,
          description: 'Voicemail recording ready',
          metadata: { recordingSid, duration: 12, context: 'voicemail' },
        },
      });

      expect(twilioRequests()).toEqual([
        { method: 'GET', url: `${recordingUrl}.mp3`, authorization: basicAuth },
        {
          method: 'DELETE',
          url: `${recordingUrl}.json`,
          authorization: basicAuth,
        },
      ]);
      expect(harness.mediaStore.keys()).toEqual([recordingKey]);
      await expect(harness.mediaStore.head(recordingKey)).resolves.toEqual({
        contentType: 'audio/mpeg',
        contentLength: audioBytes.byteLength,
      });
      expect(harness.db.callRecording.update.mock.calls).toEqual([
        [
          {
            where: { id: 'recording-1' },
            data: { objectKey: recordingKey, storedAt: expect.any(Date) },
          },
        ],
        [
          {
            where: { id: 'recording-1' },
            data: { providerDeletedAt: expect.any(Date) },
          },
        ],
      ]);
    });

    test('records a conference recording under its own timeline entry and copies it too', async () => {
      await harness.emit(
        CHANNELS.CALL_RECORDING_READY,
        recordingReady({ context: 'conference', duration: 340 }),
      );

      expect(harness.db.callRecording.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            context: 'CONFERENCE',
            duration: 340,
          }),
        }),
      );
      expect(harness.db.callEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'RECORDING_COMPLETED',
          description: 'Call recording ready',
          metadata: { recordingSid, duration: 340, context: 'conference' },
        }),
      });
      expect(harness.mediaStore.keys()).toEqual([recordingKey]);
      expect(twilioRequests().map(({ method }) => method)).toEqual([
        'GET',
        'DELETE',
      ]);
    });

    test('a recording without a context is a voicemail', async () => {
      await harness.emit(
        CHANNELS.CALL_RECORDING_READY,
        recordingReady({ context: undefined }),
      );

      expect(harness.db.callEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ eventType: 'VOICEMAIL_COMPLETED' }),
      });
    });

    test('streams the audio into the store as Twilio sends it, so a whole call never sits in memory', async () => {
      const put = vi.spyOn(harness.mediaStore, 'put');

      await harness.emit(
        CHANNELS.CALL_RECORDING_READY,
        recordingReady({ context: 'conference', duration: 3_600 }),
      );

      expect(put).toHaveBeenCalledWith({
        key: recordingKey,
        contentType: 'audio/mpeg',
        contentLength: audioBytes.byteLength,
        body: expect.any(Readable),
      });
      await expect(harness.mediaStore.get(recordingKey)).resolves.toEqual({
        contentType: 'audio/mpeg',
        contentLength: audioBytes.byteLength,
        body: expect.any(Readable),
      });
    });

    test('holds the audio whole, within its cap, when Twilio declares no length', async () => {
      const put = vi.spyOn(harness.mediaStore, 'put');
      harness.fetchMock.mockImplementation(async (_url, init) =>
        init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : audio(audioBytes, { 'content-type': 'audio/mpeg' }),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      expect(put).toHaveBeenCalledWith({
        key: recordingKey,
        contentType: 'audio/mpeg',
        body: audioBytes,
      });
      expect(twilioRequests().map(({ method }) => method)).toEqual([
        'GET',
        'DELETE',
      ]);
    });

    test('keeps the recording at Twilio when Twilio stops sending it midway', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let pulls = 0;
      harness.fetchMock.mockImplementation(async (_url, init) =>
        audio(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new Uint8Array(1024));
                return;
              }
              return abortedBy(init?.signal);
            },
          }),
          { 'content-type': 'audio/mpeg', 'content-length': '4096' },
        ),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());
      await vi.waitFor(() => expect(pulls).toBe(2));
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(harness.logger.warn).toHaveBeenCalled());

      expect(harness.mediaStore.keys()).toEqual([]);
      expect(harness.db.callRecording.update).not.toHaveBeenCalled();
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
      expect(harness.logger.warn).toHaveBeenCalledWith(
        { conversationUuid: 'conv-1', recordingSid, reason: 'cut-off' },
        'Twilio did not send the whole recording; playback keeps fetching it from Twilio',
      );
    });

    test('refuses a recording that declares more than a call recording can weigh, unread', async () => {
      const body = new ReadableStream<Uint8Array>();
      harness.fetchMock.mockImplementation(async () =>
        audio(body, {
          'content-type': 'audio/mpeg',
          'content-length': String(64 * MEBIBYTE + 1),
        }),
      );

      await harness.emit(
        CHANNELS.CALL_RECORDING_READY,
        recordingReady({ context: 'conference' }),
      );

      expect(body.locked).toBe(false);
      expect(harness.fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(harness.mediaStore.keys()).toEqual([]);
      expect(harness.logger.warn).toHaveBeenCalledWith(
        {
          conversationUuid: 'conv-1',
          recordingSid,
          status: 200,
          contentType: 'audio/mpeg',
          contentLength: 64 * MEBIBYTE + 1,
        },
        'Twilio did not answer with a recording',
      );
    });

    test('stops reading a recording that runs past its cap whatever Twilio declared', async () => {
      harness.fetchMock.mockImplementation(async () =>
        audio(new Uint8Array(5 * MEBIBYTE + 1), {
          'content-type': 'audio/mpeg',
          'content-length': '1024',
        }),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      expect(harness.fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(harness.mediaStore.keys()).toEqual([]);
      expect(harness.db.callRecording.update).not.toHaveBeenCalled();
      expect(harness.logger.warn).toHaveBeenCalledWith(
        { conversationUuid: 'conv-1', recordingSid, reason: 'too-large' },
        'Twilio did not send the whole recording; playback keeps fetching it from Twilio',
      );
    });

    test('keeps the recording at Twilio, and playable from there, while Twilio has no media for it yet', async () => {
      harness.fetchMock.mockResolvedValue(
        new Response('<TwilioResponse>not found</TwilioResponse>', {
          status: 404,
          headers: { 'content-type': 'application/xml' },
        }),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      // The row and the timeline entry are written before the copy is tried.
      expect(harness.db.callRecording.upsert).toHaveBeenCalledTimes(1);
      expect(harness.db.callEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ eventType: 'VOICEMAIL_COMPLETED' }),
      });
      expect(harness.mediaStore.keys()).toEqual([]);
      expect(harness.db.callRecording.update).not.toHaveBeenCalled();
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
      expect(harness.logger.info).toHaveBeenCalledWith(
        { conversationUuid: 'conv-1', recordingSid },
        'Recording not yet available at Twilio; playback will fetch it from Twilio until it is copied',
      );
      expect(harness.logger.warn).not.toHaveBeenCalled();
    });

    test('keeps the recording at Twilio when Twilio does not answer in time', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      harness.fetchMock.mockImplementation((_url, init) =>
        abortedBy(init?.signal),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());
      await vi.advanceTimersByTimeAsync(30_000);
      await harness.emit(CHANNELS.CALL_INCOMING, {
        conversationUuid: 'conv-2',
        from,
        to,
        timestamp,
      } satisfies ChannelInput<'call:incoming'>);

      expect(harness.mediaStore.keys()).toEqual([]);
      expect(harness.db.callRecording.update).not.toHaveBeenCalled();
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
      expect(harness.logger.warn).toHaveBeenCalledWith(
        { conversationUuid: 'conv-1', recordingSid, reason: 'TimeoutError' },
        'Could not reach Twilio for a recording',
      );
    });

    test('keeps the recording at Twilio when the store refuses the copy', async () => {
      vi.spyOn(harness.mediaStore, 'put').mockRejectedValue(
        new Error('bucket unavailable'),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      expect(harness.db.callRecording.update).not.toHaveBeenCalled();
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
      expect(harness.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ conversationUuid: 'conv-1', recordingSid }),
        'Could not store the recording; playback keeps fetching it from Twilio',
      );
    });

    test('keeps the recording at Twilio when the copy cannot be recorded', async () => {
      harness.db.callRecording.update.mockRejectedValueOnce(
        new Error('db down'),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      expect(harness.mediaStore.keys()).toEqual([recordingKey]);
      expect(harness.db.callRecording.update).toHaveBeenCalledTimes(1);
      expect(twilioRequests().map(({ method }) => method)).toEqual(['GET']);
      expect(harness.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ conversationUuid: 'conv-1', recordingSid }),
        'Stored the recording but could not record the copy; playback keeps fetching it from Twilio',
      );
    });

    test.each([
      {
        name: 'refuses to delete',
        respond: () => new Response('upstream detail', { status: 500 }),
        expected: {
          context: { conversationUuid: 'conv-1', recordingSid, status: 500 },
          message:
            'Twilio did not delete the recording; it stays there until a later sweep',
        },
      },
      {
        name: 'cannot be reached for the deletion',
        respond: () => Promise.reject(new TypeError('fetch failed')),
        expected: {
          context: {
            conversationUuid: 'conv-1',
            recordingSid,
            reason: 'TypeError',
          },
          message:
            'Could not reach Twilio to delete the recording; it stays there until a later sweep',
        },
      },
    ])(
      'keeps the copy and logs the SID when Twilio $name',
      async ({ respond, expected }) => {
        harness.fetchMock.mockImplementation(async (_url, init) =>
          init?.method === 'DELETE' ? respond() : audio(),
        );

        await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

        expect(harness.mediaStore.keys()).toEqual([recordingKey]);
        expect(harness.db.callRecording.update).toHaveBeenCalledTimes(1);
        expect(harness.db.callRecording.update).toHaveBeenCalledWith({
          where: { id: 'recording-1' },
          data: { objectKey: recordingKey, storedAt: expect.any(Date) },
        });
        expect(harness.logger.warn).toHaveBeenCalledWith(
          expected.context,
          expected.message,
        );
      },
    );

    test('treats a recording Twilio no longer has as deleted', async () => {
      harness.fetchMock.mockImplementation(async (_url, init) =>
        init?.method === 'DELETE'
          ? new Response('<TwilioResponse>not found</TwilioResponse>', {
              status: 404,
            })
          : audio(),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      expect(harness.db.callRecording.update).toHaveBeenLastCalledWith({
        where: { id: 'recording-1' },
        data: { providerDeletedAt: expect.any(Date) },
      });
    });

    test('drops a recording whose URL is not a Twilio recording', async () => {
      await harness.emit(
        CHANNELS.CALL_RECORDING_READY,
        recordingReady({
          recordingUrl: 'https://recordings.example.com/rec-1.mp3',
        }),
      );

      expect(harness.db.callRecording.upsert).not.toHaveBeenCalled();
      expect(harness.db.callEvent.create).not.toHaveBeenCalled();
      expect(harness.fetchMock).not.toHaveBeenCalled();
      expect(harness.logger.error).toHaveBeenCalledWith(
        { conversationUuid: 'conv-1', context: 'VOICEMAIL' },
        'Dropped a recording whose URL is not a Twilio recording',
      );
    });

    test('skips a recording for a call it has no record of', async () => {
      harness.db.call.findUnique.mockResolvedValue(null);

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      expect(harness.db.callRecording.upsert).not.toHaveBeenCalled();
      expect(harness.fetchMock).not.toHaveBeenCalled();
    });

    test('never logs the recording URL or the credentials', async () => {
      harness.fetchMock.mockRejectedValue(
        new TypeError(`fetch failed for ${recordingUrl}.mp3`),
      );

      await harness.emit(CHANNELS.CALL_RECORDING_READY, recordingReady());

      const logged = JSON.stringify([
        harness.logger.info.mock.calls,
        harness.logger.warn.mock.calls,
        harness.logger.error.mock.calls,
      ]);
      expect(logged).not.toContain('api.twilio.com');
      expect(logged).not.toContain(credentials.authToken);
      expect(logged).not.toContain(basicAuth);
    });
  });

  test('stores a transcript without logging it, naming its recording by SID', async () => {
    await harness.emit(CHANNELS.CALL_TRANSCRIPTION_READY, {
      conversationUuid: 'conv-1',
      transcript,
      recordingUrl,
      timestamp,
    } satisfies ChannelInput<'call:transcription-ready'>);

    expect(harness.db.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { transcript },
    });
    expect(harness.db.callEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'VOICEMAIL_COMPLETED',
        metadata: { recordingSid, context: undefined },
      }),
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
