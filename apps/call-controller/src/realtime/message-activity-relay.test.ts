import type { Redis } from 'ioredis';
import { describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { startMessageActivityRelay } from './message-activity-relay.js';
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
    socketIdsOf: vi.fn(
      async () =>
        new Map([
          ['user-1', ['socket-tab-a', 'socket-tab-b']],
          ['user-3', ['socket-3']],
        ]),
    ),
  };

  return {
    redis: { duplicate: () => connection as unknown as Redis },
    io: io as unknown as Pick<TypedSocketServer, 'to'>,
    ioCalls: io,
    emit,
    presence,
    connection,
    deliver(payload: unknown) {
      listener?.('message:activity', JSON.stringify(payload));
    },
  };
}

const notification = {
  kind: 'received',
  conversationId: 'conversation-1',
  userIds: ['user-1', 'user-2', 'user-3'],
};

describe('startMessageActivityRelay', () => {
  test('sends the activity to every connected browser of the audience, and keeps the audience to itself', async () => {
    const fakes = buildFakes();
    await startMessageActivityRelay({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    fakes.deliver(notification);
    await vi.waitFor(() => {
      expect(fakes.emit).toHaveBeenCalled();
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
    expect(fakes.emit).toHaveBeenCalledExactlyOnceWith('message_activity', {
      kind: 'received',
      conversationId: 'conversation-1',
    });
  });

  test('relays a delivery status change the same way', async () => {
    const fakes = buildFakes();
    await startMessageActivityRelay({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    fakes.deliver({ ...notification, kind: 'status' });
    await vi.waitFor(() => {
      expect(fakes.emit).toHaveBeenCalled();
    });

    expect(fakes.emit).toHaveBeenCalledExactlyOnceWith('message_activity', {
      kind: 'status',
      conversationId: 'conversation-1',
    });
  });

  test('never reaches the emit when the whole audience is offline', async () => {
    const fakes = buildFakes();
    fakes.presence.socketIdsOf.mockResolvedValue(new Map());
    await startMessageActivityRelay({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    fakes.deliver(notification);
    await vi.waitFor(() => {
      expect(fakes.presence.socketIdsOf).toHaveBeenCalled();
    });

    // `to([])` would address every socket there is, message or no message.
    expect(fakes.ioCalls.to).not.toHaveBeenCalled();
    expect(fakes.emit).not.toHaveBeenCalled();
  });

  test('drops a notification with nobody to send it to, rather than broadcasting it', async () => {
    const fakes = buildFakes();
    await startMessageActivityRelay({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    fakes.deliver({ ...notification, userIds: [] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fakes.presence.socketIdsOf).not.toHaveBeenCalled();
    expect(fakes.ioCalls.to).not.toHaveBeenCalled();
  });

  test('subscribes to the activity channel only', async () => {
    const fakes = buildFakes();
    await startMessageActivityRelay({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    expect(fakes.connection.subscribe).toHaveBeenCalledExactlyOnceWith(
      'message:activity',
    );
  });

  test('closes its own Redis connection', async () => {
    const fakes = buildFakes();
    const relay = await startMessageActivityRelay({
      redis: fakes.redis,
      io: fakes.io,
      presence: fakes.presence,
      log,
    });

    await relay.close();

    expect(fakes.connection.quit).toHaveBeenCalled();
  });
});
