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
    const telephony = {
      transferConversation: vi.fn(),
      holdConversation: vi.fn(),
      requestConversationHangup: vi.fn(),
    };

    const subscriber = await startCallCommandSubscriber({
      redis,
      telephony,
      log,
    });

    expect(connection.subscribe).toHaveBeenCalledWith(
      'call:transfer',
      'call:hold',
      'call:hangup',
    );

    await subscriber.close();
    expect(connection.quit).toHaveBeenCalled();
  });

  test('routes each command to the telephony service', async () => {
    const { redis, deliver } = buildFakeRedis();
    const telephony = {
      transferConversation: vi.fn(async () => 'CAagent2'),
      holdConversation: vi.fn(async () => undefined),
      requestConversationHangup: vi.fn(async () => null),
    };

    await startCallCommandSubscriber({ redis, telephony, log });

    deliver('call:transfer', {
      conversationUuid: 'CAcall1',
      targetUserId: 'user-2',
      initiatedBy: 'user-1',
    });
    deliver('call:hold', {
      conversationUuid: 'CAcall1',
      hold: true,
      initiatedBy: 'user-1',
    });
    deliver('call:hangup', {
      conversationUuid: 'CAcall1',
      initiatedBy: 'user-1',
    });
    await vi.waitFor(() => {
      expect(telephony.requestConversationHangup).toHaveBeenCalled();
    });

    expect(telephony.transferConversation).toHaveBeenCalledWith(
      'CAcall1',
      'user-2',
      'user-1',
    );
    expect(telephony.holdConversation).toHaveBeenCalledWith('CAcall1', true);
    expect(telephony.requestConversationHangup).toHaveBeenCalledWith(
      'CAcall1',
      'user-1',
    );
  });

  test('drops a command that does not match its schema', async () => {
    const { redis, deliver } = buildFakeRedis();
    const telephony = {
      transferConversation: vi.fn(),
      holdConversation: vi.fn(),
      requestConversationHangup: vi.fn(),
    };

    await startCallCommandSubscriber({ redis, telephony, log });
    deliver('call:hold', { conversationUuid: 'CAcall1' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(telephony.holdConversation).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
