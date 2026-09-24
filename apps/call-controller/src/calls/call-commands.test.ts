import type { Redis } from 'ioredis';
import { describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { startCallCommandSubscriber } from './call-commands.js';

function buildFakeRedis() {
  let listener: ((channel: string, message: string) => void) | undefined;
  const connection = {
    subscribe: vi.fn(async () => 3),
    on: vi.fn((_event: string, handler: typeof listener) => {
      listener = handler;
    }),
    quit: vi.fn(async () => 'OK'),
  };
  const redis = {
    duplicate: () => connection as unknown as Redis,
  };

  return {
    redis,
    connection,
    deliver(channel: string, payload: unknown) {
      listener?.(channel, JSON.stringify(payload));
    },
  };
}

const log = createFakeLogger();

describe('startCallCommandSubscriber', () => {
  test('subscribes to the command channels on a dedicated connection', async () => {
    const { redis, connection } = buildFakeRedis();
    const flow = { endCall: vi.fn() };

    const subscriber = await startCallCommandSubscriber({
      redis,
      flow,
      log,
    });

    expect(connection.subscribe).toHaveBeenCalledWith('call:hangup');

    await subscriber.close();
    expect(connection.quit).toHaveBeenCalled();
  });

  test('ends the call through the flow, which lets its users go', async () => {
    const { redis, deliver } = buildFakeRedis();
    const flow = { endCall: vi.fn(async () => null) };

    await startCallCommandSubscriber({ redis, flow, log });

    deliver('call:hangup', {
      conversationUuid: 'CAcall1',
      initiatedBy: 'user-1',
    });
    await vi.waitFor(() => {
      expect(flow.endCall).toHaveBeenCalled();
    });

    expect(flow.endCall).toHaveBeenCalledWith('CAcall1', 'user-1');
  });

  test('no longer acts on hold or transfer commands: nothing checks them against the call', async () => {
    const { redis, deliver } = buildFakeRedis();
    const flow = { endCall: vi.fn() };

    await startCallCommandSubscriber({ redis, flow, log });
    deliver('call:hold', {
      conversationUuid: 'CAcall1',
      hold: true,
      initiatedBy: 'user-1',
    });
    deliver('call:transfer', {
      conversationUuid: 'CAcall1',
      targetUserId: 'user-2',
      initiatedBy: 'user-1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(flow.endCall).not.toHaveBeenCalled();
  });

  test('drops a command that does not match its schema', async () => {
    const { redis, deliver } = buildFakeRedis();
    const flow = { endCall: vi.fn() };

    await startCallCommandSubscriber({ redis, flow, log });
    deliver('call:hangup', { conversationUuid: 'CAcall1' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(flow.endCall).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
