import type { CallRecord, MessageConversationListItem } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  callInboxItem,
  compareInboxItems,
  conversationInboxItem,
  hasMoreInboxItems,
  type InboxItem,
  inboxQueryFor,
  inboxWatermark,
  isMissedCall,
  mergeInboxPage,
  visibleInboxItems,
} from './inbox-item';

const call: CallRecord = {
  id: 'call-1',
  conversationUuid: 'conversation-1',
  callerLegUuid: null,
  agentLegUuid: null,
  externalLegUuid: null,
  from: '+15155550104',
  to: '+15155550101',
  status: 'completed',
  duration: 42,
  recordingUrl: null,
  transcript: null,
  direction: 'inbound',
  provider: 'TWILIO',
  userId: null,
  departmentId: null,
  user: null,
  department: null,
  contact: null,
  line: null,
  hasVoicemail: false,
  createdAt: '2026-03-20T10:00:00.000Z',
  updatedAt: '2026-03-20T10:00:00.000Z',
};

const conversation: MessageConversationListItem = {
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
  lastMessageAt: '2026-03-20T09:00:00.000Z',
  lastMessagePreview: 'Hey, can you call me back?',
  lastMessageDirection: 'INBOUND',
  lastMessageStatus: 'DELIVERED',
  isSuppressed: false,
  createdAt: '2026-03-19T09:00:00.000Z',
  updatedAt: '2026-03-20T09:00:00.000Z',
};

/** A synthetic row at a given time, for the ordering and paging cases. */
function itemAt(key: string, sortKey: number): InboxItem {
  return { kind: 'call', key, sortKey, call };
}

describe('callInboxItem', () => {
  test('namespaces the key so a call and a conversation never collide', () => {
    expect(callInboxItem(call)?.key).toBe('call:call-1');
    expect(conversationInboxItem(conversation)?.key).toBe(
      'conversation:conversation-a',
    );
  });

  test('sorts on the instant, not on the text of the timestamp', () => {
    const early = callInboxItem({
      ...call,
      createdAt: '2026-03-20T00:00:00+02:00',
    });
    const late = callInboxItem({ ...call, createdAt: '2026-03-20T01:00:00Z' });

    expect(early?.sortKey).toBeLessThan(late?.sortKey ?? 0);
  });
});

describe('conversationInboxItem', () => {
  test('leaves out a conversation nobody has messaged yet', () => {
    expect(
      conversationInboxItem({ ...conversation, lastMessageAt: null }),
    ).toBeNull();
  });
});

describe('isMissedCall', () => {
  test.each(['missed', 'no-answer', 'busy'])(
    'counts %s as missed',
    (status) => {
      expect(isMissedCall({ status })).toBe(true);
    },
  );

  test.each(['completed', 'in-progress'])('does not count %s', (status) => {
    expect(isMissedCall({ status })).toBe(false);
  });
});

describe('mergeInboxPage', () => {
  test('keeps a row that a shifted page repeated across the boundary', () => {
    const loaded = [itemAt('call:a', 300), itemAt('call:b', 200)];
    const page = [itemAt('call:b', 200), itemAt('call:c', 100)];

    expect(mergeInboxPage(loaded, page).map((item) => item.key)).toEqual([
      'call:a',
      'call:b',
      'call:c',
    ]);
  });

  test('orders equal timestamps by key so the list does not shuffle', () => {
    const merged = mergeInboxPage(
      [],
      [itemAt('call:b', 100), itemAt('call:a', 100)],
    );

    expect(merged.map((item) => item.key)).toEqual(['call:a', 'call:b']);
    expect(
      compareInboxItems(itemAt('call:a', 100), itemAt('call:a', 100)),
    ).toBe(0);
  });
});

describe('inboxWatermark', () => {
  test('shows nothing while a source with pages left has loaded none', () => {
    expect(
      inboxWatermark([
        { items: [itemAt('call:a', 300)], exhausted: true },
        { items: [], exhausted: false },
      ]),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  test('shows everything once both sources are exhausted', () => {
    expect(
      inboxWatermark([
        { items: [itemAt('call:a', 300)], exhausted: true },
        { items: [], exhausted: true },
      ]),
    ).toBe(Number.NEGATIVE_INFINITY);
  });

  test('stops at the newest of the unfinished sources', () => {
    expect(
      inboxWatermark([
        {
          items: [itemAt('call:a', 300), itemAt('call:b', 200)],
          exhausted: false,
        },
        {
          items: [itemAt('call:c', 250), itemAt('call:d', 150)],
          exhausted: false,
        },
      ]),
    ).toBe(200);
  });
});

describe('visibleInboxItems', () => {
  test('hides rows a later page could still be inserted above', () => {
    const visible = visibleInboxItems([
      {
        items: [itemAt('call:a', 300), itemAt('call:b', 200)],
        exhausted: false,
      },
      {
        items: [itemAt('call:c', 250), itemAt('call:d', 150)],
        exhausted: true,
      },
    ]);

    // The unfinished source is loaded down to 200, so 150 stays hidden: the
    // next page of that source could land between the two.
    expect(visible.map((item) => item.key)).toEqual([
      'call:a',
      'call:c',
      'call:b',
    ]);
  });

  test('holds nothing back once every source is exhausted', () => {
    const visible = visibleInboxItems([
      { items: [itemAt('call:a', 300)], exhausted: true },
      { items: [itemAt('call:d', 150)], exhausted: true },
    ]);

    expect(visible.map((item) => item.key)).toEqual(['call:a', 'call:d']);
    expect(hasMoreInboxItems([{ items: [], exhausted: true }])).toBe(false);
  });
});

describe('inboxQueryFor', () => {
  test('reads both lists for All and neither list twice for the rest', () => {
    expect(inboxQueryFor('all')).toEqual({ calls: {}, conversations: {} });
    expect(inboxQueryFor('calls').conversations).toBeNull();
    expect(inboxQueryFor('messages').calls).toBeNull();
  });

  test('asks the database for the narrow tabs rather than filtering a page', () => {
    expect(inboxQueryFor('missed').calls).toEqual({
      status: ['missed', 'no-answer', 'busy'],
    });
    expect(inboxQueryFor('voicemails').calls).toEqual({ hasVoicemail: true });
    expect(inboxQueryFor('unread').conversations).toEqual({ unreadOnly: true });
  });

  test('leaves calls out of Unread, which no call record can answer', () => {
    expect(inboxQueryFor('unread').calls).toBeNull();
  });
});

describe('inboxQueryFor with a line scope', () => {
  const scope = { linePhone: '+15555550188', sourcePhoneNumberId: 'line-1' };

  test('narrows both lists to that line', () => {
    expect(inboxQueryFor('all', scope)).toEqual({
      calls: { linePhone: '+15555550188' },
      conversations: { sourcePhoneNumberId: 'line-1' },
    });
  });

  test('keeps the filter the tab asks for', () => {
    expect(inboxQueryFor('voicemails', scope)).toEqual({
      calls: { hasVoicemail: true, linePhone: '+15555550188' },
      conversations: null,
    });
  });

  test('leaves a list the tab ignores out', () => {
    expect(inboxQueryFor('messages', scope).calls).toBeNull();
  });
});

describe('inboxQueryFor on a line that carries no messages', () => {
  const voiceOnly = { linePhone: '+15555550188', sourcePhoneNumberId: null };

  test('reads calls only', () => {
    expect(inboxQueryFor('all', voiceOnly)).toEqual({
      calls: { linePhone: '+15555550188' },
      conversations: null,
    });
  });

  test('has nothing to show on a messages tab', () => {
    expect(inboxQueryFor('messages', voiceOnly)).toEqual({
      calls: null,
      conversations: null,
    });
  });
});
