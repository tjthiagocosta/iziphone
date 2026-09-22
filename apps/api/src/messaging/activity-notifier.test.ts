import type { PrismaClient } from '@repo/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageActivityNotifier } from './activity-notifier.js';

const CONVERSATION_ID = 'conversation-1';

describe('MessageActivityNotifier', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  test('tells the owner of the line the conversation is on', async () => {
    harness.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      department: null,
    });

    await harness.notifier.notify(CONVERSATION_ID, 'received');

    expect(harness.published()).toEqual([
      {
        channel: 'message:activity',
        payload: {
          kind: 'received',
          conversationId: CONVERSATION_ID,
          userIds: ['user-1'],
        },
      },
    ]);
  });

  test('tells every member of the department the line belongs to', async () => {
    harness.findUnique.mockResolvedValueOnce({
      userId: null,
      department: {
        deletedAt: null,
        users: [{ userId: 'user-1' }, { userId: 'user-2' }],
      },
    });

    await harness.notifier.notify(CONVERSATION_ID, 'status');

    expect(harness.published()[0]?.payload).toEqual({
      kind: 'status',
      conversationId: CONVERSATION_ID,
      userIds: ['user-1', 'user-2'],
    });
  });

  test('names somebody once when they own the line and are in its department', async () => {
    harness.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      department: {
        deletedAt: null,
        users: [{ userId: 'user-1' }, { userId: 'user-2' }],
      },
    });

    await harness.notifier.notify(CONVERSATION_ID, 'received');

    expect(harness.published()[0]?.payload).toMatchObject({
      userIds: ['user-1', 'user-2'],
    });
  });

  test('says nothing when a deleted department leaves nobody who can see it', async () => {
    harness.findUnique.mockResolvedValueOnce({
      userId: null,
      department: {
        deletedAt: new Date('2026-09-01T00:00:00.000Z'),
        users: [{ userId: 'user-1' }],
      },
    });

    await harness.notifier.notify(CONVERSATION_ID, 'received');

    expect(harness.published()).toEqual([]);
    expect(harness.log.warn).not.toHaveBeenCalled();
  });

  test('says nothing about a conversation that is not there', async () => {
    harness.findUnique.mockResolvedValueOnce(null);

    await harness.notifier.notify(CONVERSATION_ID, 'received');

    expect(harness.published()).toEqual([]);
  });

  test('carries no message content, only ids', async () => {
    harness.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      department: null,
    });

    await harness.notifier.notify(CONVERSATION_ID, 'received');

    const [sent] = harness.publish.mock.calls;
    expect(Object.keys(JSON.parse(String(sent?.[1])) as object).sort()).toEqual(
      ['conversationId', 'kind', 'userIds'],
    );
  });

  test('a Redis failure is a warning, not a failed webhook', async () => {
    harness.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      department: null,
    });
    harness.publish.mockRejectedValueOnce(new Error('Redis is away'));

    await expect(
      harness.notifier.notify(CONVERSATION_ID, 'received'),
    ).resolves.toBeUndefined();
    expect(harness.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        kind: 'received',
      }),
      expect.stringContaining('conversation changed'),
    );
  });

  test('a database failure resolving the audience is a warning too', async () => {
    harness.findUnique.mockRejectedValueOnce(
      new Error('connection terminated'),
    );

    await expect(
      harness.notifier.notify(CONVERSATION_ID, 'status'),
    ).resolves.toBeUndefined();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(harness.log.warn).toHaveBeenCalled();
  });
});

function createHarness() {
  const findUnique = vi.fn();
  const publish = vi.fn(async (_channel: string, _message: string) => 1);
  const log = { warn: vi.fn() };

  const notifier = new MessageActivityNotifier({
    db: {
      messageConversation: { findUnique },
    } as unknown as PrismaClient,
    redis: { publish },
    log,
  });

  return {
    notifier,
    findUnique,
    publish,
    log,
    published: () =>
      publish.mock.calls.map(([channel, message]) => ({
        channel,
        payload: JSON.parse(String(message)) as unknown,
      })),
  };
}
