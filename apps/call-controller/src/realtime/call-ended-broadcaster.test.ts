import type { Redis } from 'ioredis';
import { describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { startCallEndedBroadcaster } from './call-ended-broadcaster.js';
import type { TypedSocketServer } from './socket-server.js';

const log = createFakeLogger();

function buildFakes() {
  let listener: ((channel: string, message: string) => void) | undefined;
  const connection = {
    subscribe: vi.fn(async () => 1),
    on: vi.fn((_event: string, handler: typeof listener) => {
      listener = handler;
    }),
    quit: vi.fn(async () => 'OK'),
  };
  const emit = vi.fn();
  const io = { to: vi.fn((_socketIds: string[]) => ({ emit })) };
  const presence = {
    callParticipants: vi.fn(async () => ['user-1', 'user-2', 'user-3']),
    socketIdsOf: vi.fn(
      async () =>
        new Map([
          ['user-1', ['socket-tab-a', 'socket-tab-b']],
          ['user-3', ['socket-3']],
        ]),
    ),
    removeCallParticipants: vi.fn(async () => undefined),
  };

  return {
    redis: { duplicate: () => connection as unknown as Redis },
    io: io as unknown as Pick<TypedSocketServer, 'to'>,
    ioCalls: io,
    emit,
    presence,
    connection,
    deliver(payload: unknown) {
      listener?.('call:ended', JSON.stringify(payload));
    },
  };
}

describe('startCallEndedBroadcaster', () => {
  test('tells every connected softphone of the participants that the call ended, then forgets the call', async () => {
    const fakes = buildFakes();
    await startCallEndedBroadcaster({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    fakes.deliver({
      conversationUuid: 'CAcall1',
      duration: 42,
      status: 'completed',
      timestamp: '2026-09-08T12:00:00.000Z',
    });
    await vi.waitFor(() => {
      expect(fakes.presence.removeCallParticipants).toHaveBeenCalledWith(
        'CAcall1',
      );
    });

    expect(fakes.presence.socketIdsOf).toHaveBeenCalledWith([
      'user-1',
      'user-2',
      'user-3',
    ]);
    expect(fakes.ioCalls.to).toHaveBeenCalledExactlyOnceWith([
      'socket-tab-a',
      'socket-tab-b',
      'socket-3',
    ]);
    expect(fakes.emit).toHaveBeenCalledExactlyOnceWith('call_ended', {
      conversationUuid: 'CAcall1',
      status: 'completed',
      duration: 42,
      endedAt: '2026-09-08T12:00:00.000Z',
    });
  });

  test('tells nobody when every participant has gone offline, and still forgets the call', async () => {
    const fakes = buildFakes();
    fakes.presence.socketIdsOf.mockResolvedValue(new Map());
    await startCallEndedBroadcaster({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    fakes.deliver({
      conversationUuid: 'CAcall3',
      duration: 0,
      status: 'no-answer',
      timestamp: '2026-09-08T12:00:00.000Z',
    });
    await vi.waitFor(() => {
      expect(fakes.presence.removeCallParticipants).toHaveBeenCalledWith(
        'CAcall3',
      );
    });

    expect(fakes.ioCalls.to).not.toHaveBeenCalled();
    expect(fakes.emit).not.toHaveBeenCalled();
  });

  test('ignores calls nobody was offered', async () => {
    const fakes = buildFakes();
    fakes.presence.callParticipants.mockResolvedValue([]);
    await startCallEndedBroadcaster({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    fakes.deliver({
      conversationUuid: 'CAcall2',
      duration: 0,
      status: 'no-answer',
      timestamp: '2026-09-08T12:00:00.000Z',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fakes.emit).not.toHaveBeenCalled();
    expect(fakes.presence.removeCallParticipants).not.toHaveBeenCalled();
  });

  test('closes its own Redis connection', async () => {
    const fakes = buildFakes();
    const broadcaster = await startCallEndedBroadcaster({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    await broadcaster.close();

    expect(fakes.connection.quit).toHaveBeenCalled();
  });
});
