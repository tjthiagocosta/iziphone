import type {
  Message,
  MessageConversation,
  MessageListResponse,
} from '@repo/dto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type MessageThreadDeps,
  MessageThreadSession,
  type MessageThreadState,
  REFRESH_MS,
  shownThread,
  UNANSWERED_MS,
} from './message-thread-session';

function conversation(
  overrides: Partial<MessageConversation> = {},
): MessageConversation {
  return {
    id: 'conversation-a',
    contact: {
      id: 'contact-1',
      name: 'Jordan Blake',
      phoneNumber: '+15155550105',
    },
    sourcePhoneNumber: {
      id: 'number-1',
      phoneNumber: '+15155550101',
      label: 'Sales',
    },
    owner: null,
    unreadCount: 0,
    lastReadAt: null,
    lastMessageAt: '2026-03-20T09:03:00.000Z',
    lastMessagePreview: 'Body of m3',
    lastMessageDirection: 'INBOUND',
    lastMessageStatus: 'RECEIVED',
    isSuppressed: false,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-20T09:03:00.000Z',
    ...overrides,
  };
}

/** `m3` was created at 09:03, so ids and times line up. */
function message(n: number, overrides: Partial<Message> = {}): Message {
  return {
    id: `m${n}`,
    conversationId: 'conversation-a',
    direction: 'INBOUND',
    channel: 'SMS',
    status: 'RECEIVED',
    body: `Body of m${n}`,
    from: '+15155550105',
    to: '+15155550101',
    failureCode: null,
    failureReason: null,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    createdAt: `2026-03-20T09:${String(n).padStart(2, '0')}:00.000Z`,
    attachments: [],
    ...overrides,
  };
}

function outbound(n: number, status: Message['status']): Message {
  return message(n, {
    direction: 'OUTBOUND',
    status,
    from: '+15155550101',
    to: '+15155550105',
  });
}

/** A page the way the endpoint answers it: newest first. */
function pageOf(messages: Message[], hasMore = false): MessageListResponse {
  return { messages: [...messages].reverse(), hasMore };
}

/** Lets everything that is ready to run, run, without moving the clock. */
function settle(): Promise<unknown> {
  return vi.advanceTimersByTimeAsync(0);
}

function harness(options: { visible?: boolean } = {}) {
  let visible = options.visible ?? true;
  const listeners = new Set<() => void>();
  const states: MessageThreadState[] = [];

  const deps = {
    fetchConversation: vi.fn<MessageThreadDeps['fetchConversation']>(async () =>
      conversation(),
    ),
    fetchMessages: vi.fn<MessageThreadDeps['fetchMessages']>(async () =>
      pageOf([message(1), message(2), message(3)]),
    ),
    markRead: vi.fn<MessageThreadDeps['markRead']>(async () => {}),
    isVisible: () => visible,
    onVisibilityChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies MessageThreadDeps;

  const open = (conversationId = 'conversation-a') =>
    new MessageThreadSession(conversationId, deps, (state) => {
      states.push(state);
    });

  return {
    deps,
    states,
    open,
    /** A session whose first load has landed. */
    async opened() {
      const session = open();
      session.start();
      await settle();
      return session;
    },
    last(): MessageThreadState {
      const state = states[states.length - 1];
      if (!state) {
        throw new Error('The session has not reported a state');
      }
      return state;
    },
    ids(): string[] {
      return (states[states.length - 1]?.messages ?? []).map(
        (entry) => entry.id,
      );
    },
    show() {
      visible = true;
      for (const listener of listeners) listener();
    },
    hide() {
      visible = false;
      for (const listener of listeners) listener();
    },
    watchers: () => listeners.size,
  };
}

describe('MessageThreadSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the first load', () => {
    test('reports loading, then the header and the newest page, oldest first', async () => {
      const thread = harness();
      const session = thread.open();

      session.start();
      expect(thread.last()).toMatchObject({
        conversationId: 'conversation-a',
        conversation: null,
        messages: [],
        isLoading: true,
        error: null,
      });

      await settle();
      expect(thread.last()).toMatchObject({
        conversation: conversation(),
        hasMore: false,
        isLoading: false,
        error: null,
      });
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3']);
    });

    test('marks a thread with unread messages read', async () => {
      const thread = harness();
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ unreadCount: 2 }),
      );

      await thread.opened();

      expect(thread.deps.markRead).toHaveBeenCalledExactlyOnceWith(
        'conversation-a',
      );
    });

    test('leaves a thread with nothing unread alone', async () => {
      const thread = harness();

      await thread.opened();

      expect(thread.deps.markRead).not.toHaveBeenCalled();
    });

    test('reports a thread that cannot be loaded, and does not keep asking', async () => {
      const thread = harness();
      thread.deps.fetchConversation.mockRejectedValue(
        new Error('Conversation not found'),
      );

      await thread.opened();
      expect(thread.last()).toMatchObject({
        conversation: null,
        isLoading: false,
        error: new Error('Conversation not found'),
      });

      thread.deps.fetchMessages.mockClear();
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
      thread.show();
      await settle();
      expect(thread.deps.fetchMessages).not.toHaveBeenCalled();
    });

    test('reports a thread that loaded but could not be marked read', async () => {
      const thread = harness();
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ unreadCount: 1 }),
      );
      thread.deps.markRead.mockRejectedValueOnce(new Error('Request failed'));

      await thread.opened();

      expect(thread.ids()).toEqual(['m1', 'm2', 'm3']);
      expect(thread.last()).toMatchObject({
        isLoading: false,
        error: new Error('Request failed'),
      });
    });

    test('a refresh that starts while the first load is still marking read runs the only interval', async () => {
      const thread = harness();
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ unreadCount: 2 }),
      );
      const marking = Promise.withResolvers<void>();
      thread.deps.markRead.mockReturnValueOnce(marking.promise);
      const session = await thread.opened();
      expect(thread.last().isLoading).toBe(true);

      // This refresh is slow to answer, so it is still out when the load ends.
      const slow = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(slow.promise);
      void session.refresh();
      marking.resolve();
      await settle();
      expect(thread.last().isLoading).toBe(false);

      await vi.advanceTimersByTimeAsync(UNANSWERED_MS - 1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
    });

    test('the interval runs from the first answer, however long marking it read takes', async () => {
      const thread = harness();
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ unreadCount: 2 }),
      );
      const marking = Promise.withResolvers<void>();
      thread.deps.markRead.mockReturnValueOnce(marking.promise);
      await thread.opened();

      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);

      marking.resolve();
      await settle();
      expect(thread.last().isLoading).toBe(false);
    });

    test('looking away and back while the first load is still marking read does not ask again', async () => {
      const thread = harness();
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ unreadCount: 2 }),
      );
      const marking = Promise.withResolvers<void>();
      thread.deps.markRead.mockReturnValueOnce(marking.promise);
      await thread.opened();

      thread.hide();
      thread.show();
      marking.resolve();
      await settle();
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
      expect(thread.deps.markRead).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
    });

    test('a thread opened in a hidden tab is not marked read until it is shown', async () => {
      const thread = harness({ visible: false });
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ unreadCount: 2 }),
      );

      await thread.opened();
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3']);
      expect(thread.deps.markRead).not.toHaveBeenCalled();

      thread.show();
      await settle();
      expect(thread.deps.markRead).toHaveBeenCalledExactlyOnceWith(
        'conversation-a',
      );

      // What it loaded is still fresh; the interval runs from that load.
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
    });
  });

  describe('keeping a visible thread current', () => {
    test('reads the newest page again after every interval, and nothing else', async () => {
      const thread = harness();
      await thread.opened();
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
      expect(thread.deps.fetchMessages).toHaveBeenLastCalledWith(
        'conversation-a',
      );

      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(3);

      // One request per refresh: the header is not read again.
      expect(thread.deps.fetchConversation).toHaveBeenCalledTimes(1);
    });

    test('shows a message that arrived, without a loading state', async () => {
      const thread = harness();
      await thread.opened();
      const before = thread.states.length;

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), message(4)]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
      for (const state of thread.states.slice(before)) {
        expect(state.isLoading).toBe(false);
        expect(state.error).toBeNull();
      }
    });

    test('reports nothing when nothing changed', async () => {
      const thread = harness();
      await thread.opened();
      const before = thread.states.length;

      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);

      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(4);
      expect(thread.states).toHaveLength(before);
    });

    test('shows the delivery status of a sent message as it changes', async () => {
      const thread = harness();
      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), outbound(2, 'PENDING')]),
      );
      await thread.opened();

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), outbound(2, 'DELIVERED')]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.ids()).toEqual(['m1', 'm2']);
      expect(thread.last().messages[1]?.status).toBe('DELIVERED');
    });

    test('a refresh that fails keeps what is on screen and tries again later', async () => {
      const thread = harness();
      await thread.opened();
      const before = thread.states.length;

      thread.deps.fetchMessages.mockRejectedValueOnce(
        new Error('Failed to fetch'),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.states).toHaveLength(before);
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3']);
      expect(thread.last().error).toBeNull();

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), message(4)]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    test('a refresh that succeeds takes an older error off the screen', async () => {
      const thread = harness();
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ unreadCount: 1 }),
      );
      thread.deps.markRead.mockRejectedValueOnce(new Error('Request failed'));
      await thread.opened();
      expect(thread.last().error).toEqual(new Error('Request failed'));

      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.last().error).toBeNull();
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3']);
      // The mark-read that failed went out again with it.
      expect(thread.deps.markRead).toHaveBeenCalledTimes(2);
    });

    test('keeps the older pages the reader loaded', async () => {
      const thread = harness();
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(4), message(5), message(6)], true),
      );
      const session = await thread.opened();

      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(1), message(2), message(3)]),
      );
      await session.loadOlder();

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(5), message(6), message(7)], true),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
      expect(thread.last().hasMore).toBe(false);
    });

    test('more than a page of new messages starts the thread over, and says so', async () => {
      const thread = harness();
      await thread.opened();
      expect(thread.last().restarts).toBe(0);

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(20), message(21), message(22)], true),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.ids()).toEqual(['m20', 'm21', 'm22']);
      expect(thread.last().restarts).toBe(1);

      // A message that joins what is loaded is not another fresh start.
      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(21), message(22), message(23)], true),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.ids()).toEqual(['m20', 'm21', 'm22', 'm23']);
      expect(thread.last().restarts).toBe(1);
    });

    test('times the next refresh from the end of a slow one, so requests do not pile up', async () => {
      const thread = harness();
      await thread.opened();

      const slow = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(slow.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(UNANSWERED_MS - 1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);

      slow.resolve(pageOf([message(1), message(2), message(3)]));
      await settle();
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(3);
    });

    test('a request that never answers does not stop the thread from asking', async () => {
      const thread = harness();
      await thread.opened();

      const never = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(never.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), message(4)]),
      );
      await vi.advanceTimersByTimeAsync(UNANSWERED_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(3);
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);

      // And it is back on its interval, once.
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(4);
    });

    test('an answer that is merely slow is still used once the thread has asked again', async () => {
      const thread = harness();
      await thread.opened();

      const slow = Promise.withResolvers<MessageListResponse>();
      const next = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages
        .mockReturnValueOnce(slow.promise)
        .mockReturnValueOnce(next.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS + UNANSWERED_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(3);

      slow.resolve(pageOf([message(1), message(2), message(3), message(4)]));
      await settle();
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);

      // The newer request is still out, and still the one being waited for.
      await vi.advanceTimersByTimeAsync(UNANSWERED_MS - 1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(3);

      next.resolve(
        pageOf([message(1), message(2), message(3), message(4), message(5)]),
      );
      await settle();
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);

      // The newer request is the one that times the next: one interval.
      thread.deps.fetchMessages.mockClear();
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
    });
  });

  describe('a hidden page', () => {
    test('asks for nothing until it is shown again, then refreshes at once when one is overdue', async () => {
      const thread = harness();
      await thread.opened();
      thread.deps.fetchMessages.mockClear();

      thread.hide();
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 10);
      expect(thread.deps.fetchMessages).not.toHaveBeenCalled();

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), message(4)]),
      );
      thread.show();
      await settle();
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);

      // And it is back on its interval, once.
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
    });

    test('going back and forth between tabs asks no more often than staying', async () => {
      const thread = harness();
      await thread.opened();
      thread.deps.fetchMessages.mockClear();

      for (let flips = 0; flips < 10; flips += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        thread.hide();
        await vi.advanceTimersByTimeAsync(500);
        thread.show();
      }
      await settle();
      expect(thread.deps.fetchMessages).not.toHaveBeenCalled();

      // The refresh is due when it always was: one interval after the load.
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 15_000 - 1);
      expect(thread.deps.fetchMessages).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('coming back while a refresh is still out waits for it instead of asking again', async () => {
      const thread = harness();
      await thread.opened();

      const answer = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(answer.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);

      thread.hide();
      thread.show();
      await settle();
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);

      answer.resolve(pageOf([message(1), message(2), message(3), message(4)]));
      await settle();
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    test('does not refresh when asked to, either', async () => {
      const thread = harness();
      const session = await thread.opened();
      thread.deps.fetchMessages.mockClear();

      thread.hide();
      await session.refresh();

      expect(thread.deps.fetchMessages).not.toHaveBeenCalled();
    });
  });

  describe('read state', () => {
    test('a message from the contact that arrives in view is marked read', async () => {
      const thread = harness();
      await thread.opened();
      expect(thread.deps.markRead).not.toHaveBeenCalled();

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), message(4)]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.deps.markRead).toHaveBeenCalledExactlyOnceWith(
        'conversation-a',
      );

      // Once: the refreshes after it bring nothing new.
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 2);
      expect(thread.deps.markRead).toHaveBeenCalledTimes(1);
    });

    test('a message from the contact brings the header up to date', async () => {
      const thread = harness();
      await thread.opened();

      // The contact opted out; their STOP is the message that arrived.
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ isSuppressed: true }),
      );
      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([
          message(1),
          message(2),
          message(3),
          message(4, { body: 'STOP' }),
        ]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.last().conversation?.isSuppressed).toBe(true);
    });

    test('a header that cannot be read again keeps the last good one', async () => {
      const thread = harness();
      await thread.opened();

      thread.deps.fetchConversation.mockRejectedValue(
        new Error('Failed to fetch'),
      );
      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), message(4)]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(thread.last()).toMatchObject({
        conversation: conversation(),
        error: null,
      });
      expect(thread.deps.markRead).toHaveBeenCalledTimes(1);
    });

    test('a header that answers after a later one is dropped', async () => {
      const thread = harness();
      const session = await thread.opened();

      const overtaken = Promise.withResolvers<MessageConversation>();
      thread.deps.fetchConversation.mockReturnValueOnce(overtaken.promise);
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(2), message(3), message(4)]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      // The contact opts out while that header is still on its way.
      thread.deps.fetchConversation.mockResolvedValueOnce(
        conversation({ isSuppressed: true }),
      );
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(3), message(4), message(5, { body: 'STOP' })]),
      );
      await session.refresh();
      expect(thread.last().conversation?.isSuppressed).toBe(true);

      overtaken.resolve(conversation({ isSuppressed: false }));
      await settle();

      expect(thread.last().conversation?.isSuppressed).toBe(true);
    });

    test("a colleague's reply on the same line is shown, and is nothing to mark read", async () => {
      const thread = harness();
      await thread.opened();

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), outbound(4, 'ACCEPTED')]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(thread.deps.markRead).not.toHaveBeenCalled();
      expect(thread.deps.fetchConversation).toHaveBeenCalledTimes(1);
    });

    test('a message that lands after the page was hidden waits until the agent is back', async () => {
      const thread = harness();
      await thread.opened();

      const answer = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(answer.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      thread.hide();
      answer.resolve(pageOf([message(1), message(2), message(3), message(4)]));
      await settle();

      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(thread.deps.markRead).not.toHaveBeenCalled();

      // Back before another refresh is due: read now, without asking again.
      thread.show();
      await settle();
      expect(thread.deps.markRead).toHaveBeenCalledExactlyOnceWith(
        'conversation-a',
      );
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
    });

    test('the agent coming back marks read even when the refresh that is due fails', async () => {
      const thread = harness();
      await thread.opened();

      const answer = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(answer.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      thread.hide();
      answer.resolve(pageOf([message(1), message(2), message(3), message(4)]));
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.markRead).not.toHaveBeenCalled();

      thread.deps.fetchMessages.mockRejectedValueOnce(
        new Error('Failed to fetch'),
      );
      thread.show();
      await settle();

      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(3);
      expect(thread.deps.markRead).toHaveBeenCalledTimes(1);
    });

    test('a mark-read that fails is tried again with the next refresh, silently', async () => {
      const thread = harness();
      await thread.opened();

      thread.deps.markRead.mockRejectedValueOnce(new Error('Failed to fetch'));
      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), message(4)]),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.markRead).toHaveBeenCalledTimes(1);
      expect(thread.last().error).toBeNull();

      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.markRead).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.markRead).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshing on request, after a message is sent', () => {
    test('shows the sent message once, and restarts the interval', async () => {
      const thread = harness();
      const session = await thread.opened();
      await vi.advanceTimersByTimeAsync(REFRESH_MS / 2);

      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), outbound(4, 'PENDING')]),
      );
      await session.refresh();
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);

      // The timer that was half way is gone; the next one is a full interval
      // from this refresh, and brings the same message again.
      await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(3);
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    test('reads the header again, because a send can be what shows the contact opted out', async () => {
      const thread = harness();
      const session = await thread.opened();

      // The API refused the send and stored it as failed: nothing arrived
      // from the contact, yet the thread is now closed to sending.
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ isSuppressed: true }),
      );
      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(1), message(2), message(3), outbound(4, 'FAILED')]),
      );
      await session.refresh();

      expect(thread.last().conversation?.isSuppressed).toBe(true);
      expect(thread.deps.markRead).not.toHaveBeenCalled();
    });

    test('an answer that a later refresh overtook is dropped', async () => {
      const thread = harness();
      const session = await thread.opened();

      // The interval's refresh is asked before the send, and answers last.
      const overtaken = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(overtaken.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(1), message(2), message(3), outbound(4, 'DELIVERED')]),
      );
      await session.refresh();
      expect(thread.last().messages[3]?.status).toBe('DELIVERED');
      const before = thread.states.length;

      overtaken.resolve(
        pageOf([message(1), message(2), message(3), outbound(4, 'PENDING')]),
      );
      await settle();

      expect(thread.states).toHaveLength(before);
      expect(thread.last().messages[3]?.status).toBe('DELIVERED');

      // One interval is running, not one per refresh.
      thread.deps.fetchMessages.mockClear();
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
    });
  });

  describe('paging back', () => {
    test('asks for the page before the oldest message and puts it in front', async () => {
      const thread = harness();
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(4), message(5), message(6)], true),
      );
      const session = await thread.opened();
      expect(thread.last().hasMore).toBe(true);

      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(1), message(2), message(3)]),
      );
      await session.loadOlder();

      expect(thread.deps.fetchMessages).toHaveBeenLastCalledWith(
        'conversation-a',
        { beforeMessageId: 'm4' },
      );
      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
      expect(thread.last().hasMore).toBe(false);
    });

    test('asks for nothing once the thread is loaded to its beginning', async () => {
      const thread = harness();
      const session = await thread.opened();
      thread.deps.fetchMessages.mockClear();

      await session.loadOlder();

      expect(thread.deps.fetchMessages).not.toHaveBeenCalled();
    });

    test('reports an older page that failed and keeps the messages', async () => {
      const thread = harness();
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(4), message(5), message(6)], true),
      );
      const session = await thread.opened();

      thread.deps.fetchMessages.mockRejectedValueOnce(
        new Error('Failed to fetch'),
      );
      await session.loadOlder();

      expect(thread.ids()).toEqual(['m4', 'm5', 'm6']);
      expect(thread.last().error).toEqual(new Error('Failed to fetch'));
    });

    test('an older page that loads on the second try takes the error away', async () => {
      const thread = harness();
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(4), message(5), message(6)], true),
      );
      const session = await thread.opened();
      thread.deps.fetchMessages.mockRejectedValueOnce(
        new Error('Failed to fetch'),
      );
      await session.loadOlder();

      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(1), message(2), message(3)]),
      );
      await session.loadOlder();

      expect(thread.ids()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
      expect(thread.last().error).toBeNull();
    });

    test('drops an older page asked for before the thread restarted', async () => {
      const thread = harness();
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(4), message(5), message(6)], true),
      );
      const session = await thread.opened();

      const older = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(older.promise);
      const loading = session.loadOlder();

      // More than a page arrived meanwhile, so the thread starts over at m20.
      thread.deps.fetchMessages.mockResolvedValue(
        pageOf([message(20), message(21), message(22)], true),
      );
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      expect(thread.ids()).toEqual(['m20', 'm21', 'm22']);

      older.resolve(pageOf([message(1), message(2), message(3)]));
      await loading;

      expect(thread.ids()).toEqual(['m20', 'm21', 'm22']);
      expect(thread.last().hasMore).toBe(true);
    });
  });

  describe('once disposed', () => {
    test('stops refreshing and stops watching the page', async () => {
      const thread = harness();
      const session = await thread.opened();
      expect(thread.watchers()).toBe(1);
      thread.deps.fetchMessages.mockClear();

      session.dispose();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
      thread.show();
      await session.refresh();
      await session.loadOlder();

      expect(thread.watchers()).toBe(0);
      expect(thread.deps.fetchMessages).not.toHaveBeenCalled();
    });

    test('a first load still on its way reports nothing and marks nothing read', async () => {
      const thread = harness();
      const header = Promise.withResolvers<MessageConversation>();
      thread.deps.fetchConversation.mockReturnValueOnce(header.promise);
      const session = thread.open();
      session.start();
      const before = thread.states.length;

      session.dispose();
      header.resolve(conversation({ unreadCount: 3 }));
      await settle();
      await vi.advanceTimersByTimeAsync(REFRESH_MS);

      expect(thread.states).toHaveLength(before);
      expect(thread.deps.markRead).not.toHaveBeenCalled();
      expect(thread.deps.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('a refresh still on its way reports nothing and marks nothing read', async () => {
      const thread = harness();
      const session = await thread.opened();
      const answer = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(answer.promise);
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
      const before = thread.states.length;

      session.dispose();
      answer.resolve(pageOf([message(1), message(2), message(3), message(4)]));
      await settle();

      expect(thread.states).toHaveLength(before);
      expect(thread.deps.markRead).not.toHaveBeenCalled();
    });

    test('an older page still on its way reports nothing', async () => {
      const thread = harness();
      thread.deps.fetchMessages.mockResolvedValueOnce(
        pageOf([message(4), message(5), message(6)], true),
      );
      const session = await thread.opened();
      const older = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(older.promise);
      const loading = session.loadOlder();
      const before = thread.states.length;

      session.dispose();
      older.reject(new Error('Failed to fetch'));
      await loading;

      expect(thread.states).toHaveLength(before);
    });

    test('an answer for the thread the agent left never reaches the one they opened', async () => {
      const thread = harness();
      const late = Promise.withResolvers<MessageListResponse>();
      thread.deps.fetchMessages.mockReturnValueOnce(late.promise);
      const left = thread.open('conversation-a');
      left.start();

      // The hook disposes the session of the thread that was left and starts
      // one for the thread that was opened, reporting to the same place.
      left.dispose();
      thread.deps.fetchConversation.mockResolvedValue(
        conversation({ id: 'conversation-b' }),
      );
      thread.deps.fetchMessages.mockResolvedValue(pageOf([message(7)]));
      const opened = thread.open('conversation-b');
      opened.start();
      await settle();

      late.resolve(pageOf([message(1), message(2), message(3)]));
      await settle();

      expect(thread.last().conversationId).toBe('conversation-b');
      expect(thread.ids()).toEqual(['m7']);
    });
  });
});

describe('shownThread', () => {
  const loaded: MessageThreadState = {
    conversationId: 'conversation-a',
    conversation: conversation(),
    messages: [message(1), message(2)],
    hasMore: true,
    isLoading: false,
    error: null,
    restarts: 1,
  };

  test('shows the state of the thread that is open', () => {
    expect(shownThread(loaded, 'conversation-a')).toBe(loaded);
  });

  test("shows a thread as loading rather than under another one's messages", () => {
    // The id changed and the new session has not reported yet.
    expect(shownThread(loaded, 'conversation-b')).toEqual({
      conversation: null,
      messages: [],
      hasMore: false,
      isLoading: true,
      error: null,
      restarts: 0,
    });
  });

  test('is loading before the first report', () => {
    expect(shownThread(null, 'conversation-a').isLoading).toBe(true);
  });

  test('is not loading when no thread is open', () => {
    expect(shownThread(null, null).isLoading).toBe(false);
    expect(shownThread(loaded, null)).toMatchObject({
      conversation: null,
      messages: [],
      isLoading: false,
    });
  });
});
