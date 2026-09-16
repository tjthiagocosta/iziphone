import type { Message, MessageListResponse } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  type LoadedMessages,
  mergeNewestPage,
  NO_MESSAGES,
  prependOlderPage,
} from './message-pages';

function message(
  id: string,
  createdAt: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    conversationId: 'conversation-a',
    direction: 'INBOUND',
    channel: 'SMS',
    status: 'RECEIVED',
    body: `Body of ${id}`,
    from: '+15155550105',
    to: '+15155550101',
    failureCode: null,
    failureReason: null,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    createdAt,
    attachments: [],
    ...overrides,
  };
}

/** Minute `n` of one morning, so ids and times line up: `m3` is 09:03. */
function at(minute: number): string {
  return `2026-03-20T09:${String(minute).padStart(2, '0')}:00.000Z`;
}

function numbered(from: number, to: number): Message[] {
  const messages: Message[] = [];
  for (let n = from; n <= to; n += 1) {
    messages.push(message(`m${n}`, at(n)));
  }
  return messages;
}

/** A page the way the endpoint answers it: newest first. */
function pageOf(messages: Message[], hasMore = false): MessageListResponse {
  return { messages: [...messages].reverse(), hasMore };
}

function idsOf(loaded: LoadedMessages): string[] {
  return loaded.messages.map((entry) => entry.id);
}

describe('mergeNewestPage', () => {
  test('the first page becomes the thread, oldest first', () => {
    const { thread, arrived, restarted } = mergeNewestPage(
      NO_MESSAGES,
      pageOf(numbered(1, 3), true),
    );

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3']);
    expect(thread.hasMore).toBe(true);
    expect(arrived.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3']);
    // Nothing was loaded, so nothing was given up.
    expect(restarted).toBe(false);
  });

  test('a thread nobody has written in stays empty', () => {
    const { thread, arrived } = mergeNewestPage(NO_MESSAGES, pageOf([]));

    expect(thread).toBe(NO_MESSAGES);
    expect(arrived).toEqual([]);
  });

  test('a page that brings nothing new leaves the thread as it was', () => {
    const loaded = { messages: numbered(1, 3), hasMore: true };

    const { thread, arrived } = mergeNewestPage(
      loaded,
      pageOf(numbered(1, 3), true),
    );

    // The same object, so a caller can tell there is nothing to render.
    expect(thread).toBe(loaded);
    expect(arrived).toEqual([]);
  });

  test('new messages are added after the ones already loaded', () => {
    const loaded = { messages: numbered(1, 3), hasMore: false };

    const { thread, arrived, restarted } = mergeNewestPage(
      loaded,
      pageOf(numbered(1, 5)),
    );

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(arrived.map((entry) => entry.id)).toEqual(['m4', 'm5']);
    expect(restarted).toBe(false);
  });

  test('a message whose status changed replaces its loaded copy in place', () => {
    const sent = message('m2', at(2), {
      direction: 'OUTBOUND',
      status: 'PENDING',
    });
    const loaded = {
      messages: [message('m1', at(1)), sent, message('m3', at(3))],
      hasMore: false,
    };
    const failed: Message = {
      ...sent,
      status: 'FAILED',
      failureReason: 'The carrier refused the message',
      failedAt: at(4),
    };

    const { thread, arrived } = mergeNewestPage(
      loaded,
      pageOf([message('m1', at(1)), failed, message('m3', at(3))]),
    );

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3']);
    expect(thread.messages[1]).toEqual(failed);
    // A change to a message that was already there is not an arrival.
    expect(arrived).toEqual([]);
  });

  test('pages loaded further back stay loaded, and so does their end', () => {
    // Two pages of three are loaded; the newest page only reaches back to m5.
    const loaded = { messages: numbered(1, 6), hasMore: true };

    const { thread } = mergeNewestPage(loaded, pageOf(numbered(5, 7), true));

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    // Whether anything is older than m1 is what the older page said, not
    // what the newest page says about itself.
    expect(thread.hasMore).toBe(true);
  });

  test('a thread loaded to its beginning stays complete', () => {
    const loaded = { messages: numbered(1, 6), hasMore: false };

    const { thread } = mergeNewestPage(loaded, pageOf(numbered(5, 7), true));

    expect(thread.hasMore).toBe(false);
  });

  test('the message the agent just sent appears once', () => {
    const loaded = { messages: numbered(1, 3), hasMore: false };
    const sent = message('m4', at(4), {
      direction: 'OUTBOUND',
      status: 'PENDING',
    });

    // The refresh after sending brings it; the next one brings it again,
    // further along.
    const first = mergeNewestPage(loaded, pageOf([...numbered(1, 3), sent]));
    const second = mergeNewestPage(
      first.thread,
      pageOf([...numbered(1, 3), { ...sent, status: 'DELIVERED' }]),
    );

    expect(idsOf(first.thread)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(idsOf(second.thread)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(second.thread.messages[3]?.status).toBe('DELIVERED');
    expect(second.arrived).toEqual([]);
  });

  test('an answer older than what is loaded does not take a message away', () => {
    const loaded = { messages: numbered(1, 4), hasMore: false };

    // Read before m4 existed, applied after.
    const { thread } = mergeNewestPage(loaded, pageOf(numbered(1, 3)));

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  test('more than a page of new messages restarts the thread from the page', () => {
    const loaded = { messages: numbered(1, 6), hasMore: false };

    // m7 to m9 arrived too, but the page holds three and stops at m10.
    const { thread, arrived, restarted } = mergeNewestPage(
      loaded,
      pageOf(numbered(10, 12), true),
    );

    // Keeping m1 to m6 would hide m7 to m9 for good: paging back starts from
    // the oldest loaded message, which would still be m1.
    expect(idsOf(thread)).toEqual(['m10', 'm11', 'm12']);
    expect(thread.hasMore).toBe(true);
    expect(arrived.map((entry) => entry.id)).toEqual(['m10', 'm11', 'm12']);
    expect(restarted).toBe(true);
  });

  test('a page that meets what is loaded at one message leaves no hole', () => {
    const loaded = { messages: numbered(1, 6), hasMore: false };

    const { thread } = mergeNewestPage(loaded, pageOf(numbered(6, 8), true));

    expect(idsOf(thread)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
      'm8',
    ]);
    expect(thread.hasMore).toBe(false);
  });

  test('a message that committed late is placed where it belongs', () => {
    const loaded = {
      messages: [message('m1', at(1)), message('m3', at(3))],
      hasMore: false,
    };

    const { thread, arrived } = mergeNewestPage(loaded, pageOf(numbered(1, 3)));

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3']);
    expect(arrived.map((entry) => entry.id)).toEqual(['m2']);
  });

  test('a late message older than everything loaded moves the start of the thread', () => {
    const loaded = { messages: numbered(2, 3), hasMore: false };

    const { thread } = mergeNewestPage(loaded, pageOf(numbered(1, 3), true));

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3']);
    // The page reaches further back now, so it knows what lies beyond.
    expect(thread.hasMore).toBe(true);
  });

  test('orders by the instant, not by how the timestamp is written', () => {
    const loaded = {
      messages: [message('early', '2026-03-20T09:00:00.000Z')],
      hasMore: false,
    };
    // 08:30Z, which sorts after 09:00Z as a string.
    const offset = message('offset', '2026-03-20T10:30:00.000+02:00');

    const { thread } = mergeNewestPage(loaded, {
      messages: [message('early', '2026-03-20T09:00:00.000Z'), offset],
      hasMore: false,
    });

    expect(idsOf(thread)).toEqual(['offset', 'early']);
  });

  test('messages created in the same instant keep the order the server gave', () => {
    const tied = [message('b', at(1)), message('a', at(1))];

    const { thread } = mergeNewestPage(NO_MESSAGES, pageOf(tied, true));

    // The first one is the cursor for the next older page, so it has to be
    // the row the server ended on rather than the smaller id.
    expect(idsOf(thread)).toEqual(['b', 'a']);
  });

  test('does not change what it was given', () => {
    const messages = numbered(1, 3);
    const loaded = { messages, hasMore: false };
    const page = pageOf(numbered(2, 5));
    const pageBefore = structuredClone(page);

    mergeNewestPage(loaded, page);

    expect(loaded.messages).toBe(messages);
    expect(idsOf(loaded)).toEqual(['m1', 'm2', 'm3']);
    expect(page).toEqual(pageBefore);
  });
});

describe('prependOlderPage', () => {
  test('puts the older page in front and takes its end', () => {
    const loaded = { messages: numbered(4, 6), hasMore: true };

    const thread = prependOlderPage(loaded, pageOf(numbered(1, 3)), 'm4');

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(thread.hasMore).toBe(false);
  });

  test('keeps paging while the older page says there is more', () => {
    const loaded = { messages: numbered(4, 6), hasMore: true };

    const thread = prependOlderPage(loaded, pageOf(numbered(2, 3), true), 'm4');

    expect(thread.hasMore).toBe(true);
  });

  test('drops the second answer to a page asked for twice', () => {
    const loaded = { messages: numbered(4, 6), hasMore: true };
    const older = pageOf(numbered(1, 3));

    const once = prependOlderPage(loaded, older, 'm4');
    const twice = prependOlderPage(once, older, 'm4');

    expect(twice).toBe(once);
  });

  test('drops a page asked for before the thread restarted', () => {
    // The thread restarted from m10 while the page before m4 was on its way.
    const restarted = { messages: numbered(10, 12), hasMore: true };

    const thread = prependOlderPage(restarted, pageOf(numbered(1, 3)), 'm4');

    expect(thread).toBe(restarted);
  });

  test('a message both sides hold appears once, as the page has it', () => {
    const loaded = { messages: numbered(3, 5), hasMore: true };
    const fresher = message('m3', at(3), { status: 'DELIVERED' });

    const thread = prependOlderPage(
      loaded,
      pageOf([...numbered(1, 2), fresher]),
      'm3',
    );

    expect(idsOf(thread)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(thread.messages[2]).toEqual(fresher);
  });
});
