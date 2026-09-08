import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { describe, expect, test, vi } from 'vitest';
import { ZodError } from 'zod';
import { CHANNELS } from './channels.js';
import {
  type ChannelLogger,
  createChannelSubscriber,
  createCommandPublisher,
  createEventPublisher,
  type PublishConnection,
  publish,
  type SubscribeConnection,
} from './pubsub.js';

/* ioredis clients must satisfy the connection slices without adapters. */
const _publishConnection: PublishConnection = {} as Redis;
const _subscribeConnection: SubscribeConnection = {} as Redis;

function fakeSubscribeConnection() {
  const emitter = new EventEmitter();
  const subscribe = vi.fn(async (..._channels: string[]) => _channels.length);
  const connection: SubscribeConnection = {
    subscribe,
    on: (event, listener) => emitter.on(event, listener),
  };
  const deliver = (channel: string, message: string) => {
    emitter.emit('message', channel, message);
    return new Promise((resolve) => setImmediate(resolve));
  };
  return { connection, subscribe, deliver };
}

function fakeLogger(): ChannelLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), error: vi.fn() };
}

const endedEvent = {
  conversationUuid: 'conv-1',
  duration: 42,
  status: 'completed',
  timestamp: '2026-04-21T12:00:00.000Z',
} as const;

describe('publish', () => {
  test('validates the payload and sends it as JSON', async () => {
    const connection = { publish: vi.fn(async () => 2) };

    const receivers = await publish(
      connection,
      CHANNELS.CALL_ENDED,
      endedEvent,
    );

    expect(receivers).toBe(2);
    expect(connection.publish).toHaveBeenCalledWith(
      'call:ended',
      JSON.stringify(endedEvent),
    );
  });

  test('applies schema defaults before sending', async () => {
    const connection = { publish: vi.fn(async () => 1) };

    await createEventPublisher(connection).callIncoming({
      conversationUuid: 'conv-1',
      from: '+15555550100',
      to: '+15555550199',
      timestamp: '2026-04-21T12:00:00.000Z',
    });

    const sent = JSON.parse(connection.publish.mock.calls[0]?.[1] ?? '{}');
    expect(sent.direction).toBe('inbound');
  });

  test('refuses a payload that does not match the channel', async () => {
    const connection = { publish: vi.fn(async () => 1) };

    await expect(
      createCommandPublisher(connection).hold({
        conversationUuid: 'conv-1',
        hold: 'yes' as unknown as boolean,
        initiatedBy: 'user-1',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(connection.publish).not.toHaveBeenCalled();
  });
});

describe('createChannelSubscriber', () => {
  test('subscribes to every registered channel in one call', async () => {
    const { connection, subscribe } = fakeSubscribeConnection();

    await createChannelSubscriber(connection, fakeLogger())
      .on(CHANNELS.CALL_ENDED, () => {})
      .on(CHANNELS.CALL_MISSED, () => {})
      .start();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith('call:ended', 'call:missed');
  });

  test('does not touch Redis when nothing is registered', async () => {
    const { connection, subscribe } = fakeSubscribeConnection();

    await createChannelSubscriber(connection, fakeLogger()).start();

    expect(subscribe).not.toHaveBeenCalled();
  });

  test('routes a valid message to the handler for its channel only', async () => {
    const { connection, deliver } = fakeSubscribeConnection();
    const onEnded = vi.fn();
    const onMissed = vi.fn();
    createChannelSubscriber(connection, fakeLogger())
      .on(CHANNELS.CALL_ENDED, onEnded)
      .on(CHANNELS.CALL_MISSED, onMissed);

    await deliver('call:ended', JSON.stringify(endedEvent));

    expect(onEnded).toHaveBeenCalledWith(endedEvent);
    expect(onMissed).not.toHaveBeenCalled();
  });

  test('ignores channels nobody registered', async () => {
    const { connection, deliver } = fakeSubscribeConnection();
    const logger = fakeLogger();
    const onEnded = vi.fn();
    createChannelSubscriber(connection, logger).on(
      CHANNELS.CALL_ENDED,
      onEnded,
    );

    await deliver(
      'call:hangup',
      JSON.stringify({ conversationUuid: 'c', initiatedBy: 'u' }),
    );

    expect(onEnded).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('drops and logs a message that is not JSON, without the body', async () => {
    const { connection, deliver } = fakeSubscribeConnection();
    const logger = fakeLogger();
    const onEnded = vi.fn();
    createChannelSubscriber(connection, logger).on(
      CHANNELS.CALL_ENDED,
      onEnded,
    );

    await deliver('call:ended', '{not json +15555550100');

    expect(onEnded).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls[0])).not.toContain(
      '5555550100',
    );
  });

  test('drops and logs a message that fails validation', async () => {
    const { connection, deliver } = fakeSubscribeConnection();
    const logger = fakeLogger();
    const onEnded = vi.fn();
    createChannelSubscriber(connection, logger).on(
      CHANNELS.CALL_ENDED,
      onEnded,
    );

    await deliver(
      'call:ended',
      JSON.stringify({ ...endedEvent, status: 'dropped' }),
    );

    expect(onEnded).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'call:ended' }),
      expect.stringContaining('schema'),
    );
  });

  test('logs a failing handler and keeps serving later messages', async () => {
    const { connection, deliver } = fakeSubscribeConnection();
    const logger = fakeLogger();
    const onEnded = vi
      .fn()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(undefined);
    createChannelSubscriber(connection, logger).on(
      CHANNELS.CALL_ENDED,
      onEnded,
    );

    await deliver('call:ended', JSON.stringify(endedEvent));
    await deliver('call:ended', JSON.stringify(endedEvent));

    expect(onEnded).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
