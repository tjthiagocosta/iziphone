import type {
  CallListResponse,
  CallRecord,
  MessageConversationListItem,
  MessageConversationListResponse,
} from '@repo/dto';
import { describe, expect, test } from 'vitest';
import { inboxQueryFor, visibleInboxItems } from './inbox-item';
import {
  applyCallPage,
  applyConversationPage,
  initialInboxState,
} from './inbox-paging';

/** The state this inbox starts from, named the way the hook builds it. */
function stateFor(
  tab: Parameters<typeof inboxQueryFor>[0],
  scope?: Parameters<typeof inboxQueryFor>[1],
) {
  return initialInboxState(inboxQueryFor(tab, scope));
}

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
  lastMessagePreview: 'Hey',
  lastMessageDirection: 'INBOUND',
  lastMessageStatus: 'DELIVERED',
  isSuppressed: false,
  createdAt: '2026-03-19T09:00:00.000Z',
  updatedAt: '2026-03-20T09:00:00.000Z',
};

function callPage(ids: string[], total: number, limit = 2): CallListResponse {
  return {
    calls: ids.map((id) => ({
      ...call,
      id,
      createdAt: `2026-03-20T10:00:0${id.slice(-1)}.000Z`,
    })),
    total,
    limit,
    offset: 0,
  };
}

function conversationPage(
  ids: string[],
  page: number,
  totalPages: number,
): MessageConversationListResponse {
  return {
    conversations: ids.map((id) => ({ ...conversation, id })),
    total: ids.length,
    page,
    limit: 2,
    totalPages,
  };
}

describe('initialInboxState', () => {
  test('marks the list a tab does not read as finished from the start', () => {
    expect(stateFor('messages').calls.exhausted).toBe(true);
    expect(stateFor('messages').conversations.exhausted).toBe(false);
    expect(stateFor('all').calls.exhausted).toBe(false);
  });

  test('marks messages finished on a line that cannot carry them', () => {
    const voiceOnly = {
      linePhone: '+15555550189',
      sourcePhoneNumberId: null,
    };

    expect(stateFor('all', voiceOnly).conversations.exhausted).toBe(true);
  });

  /*
   * The regression: a source that is never loaded but not marked finished
   * holds the watermark at infinity, and every row the other list did load
   * is filtered out of view.
   */
  test('shows the calls of a line that carries no messages', () => {
    const voiceOnly = {
      linePhone: '+15555550189',
      sourcePhoneNumberId: null,
    };
    const state = stateFor('all', voiceOnly);
    const calls = applyCallPage(state.calls, callPage(['call-1'], 1), 'start');

    expect(
      visibleInboxItems([calls, state.conversations]).map((item) => item.key),
    ).toEqual(['call:call-1']);
  });
});

describe('applyCallPage', () => {
  test('moves the offset forward by what the page held', () => {
    const first = applyCallPage(
      initialInboxState('calls').calls,
      callPage(['call-1', 'call-2'], 6),
      'start',
    );

    expect(first).toMatchObject({ offset: 2, exhausted: false });
    expect(
      applyCallPage(first, callPage(['call-3', 'call-4'], 6), 'next'),
    ).toMatchObject({ offset: 4, exhausted: false });
  });

  test('is finished once the offset has reached the total', () => {
    const source = { items: [], exhausted: false, offset: 4 };

    expect(
      applyCallPage(source, callPage(['call-5', 'call-6'], 6), 'next'),
    ).toMatchObject({ offset: 6, exhausted: true });
  });

  test('is finished when a page comes back shorter than it asked for', () => {
    expect(
      applyCallPage(
        initialInboxState('calls').calls,
        callPage(['call-1'], 900),
        'start',
      ),
    ).toMatchObject({ exhausted: true });
  });

  test('keeps the offset where it was when a refresh re-reads the top', () => {
    const source = { items: [], exhausted: false, offset: 40 };
    const refreshed = applyCallPage(
      source,
      callPage(['call-1', 'call-2'], 900),
      'start',
    );

    // Rows that arrived since have pushed the rest down; asking again from 40
    // repeats rows, which merging drops, where a lower offset would skip them.
    expect(refreshed.offset).toBe(40);
    expect(refreshed.exhausted).toBe(false);
  });

  test('holds one copy of a row a shifted page returned twice', () => {
    const first = applyCallPage(
      initialInboxState('calls').calls,
      callPage(['call-1', 'call-2'], 9),
      'start',
    );
    const second = applyCallPage(
      first,
      callPage(['call-2', 'call-3'], 9),
      'next',
    );

    expect(second.items.map((item) => item.key)).toEqual([
      'call:call-3',
      'call:call-2',
      'call:call-1',
    ]);
  });
});

describe('applyConversationPage', () => {
  test('asks for the page after the one it received', () => {
    const first = applyConversationPage(
      initialInboxState('messages').conversations,
      conversationPage(['conversation-a', 'conversation-b'], 1, 3),
    );

    expect(first).toMatchObject({ page: 2, exhausted: false });
  });

  test('is finished when the next page is past the last one', () => {
    expect(
      applyConversationPage(
        initialInboxState('messages').conversations,
        conversationPage(['conversation-a'], 1, 1),
      ),
    ).toMatchObject({ page: 2, exhausted: true });
  });

  test('stays finished when a refresh re-reads the first page', () => {
    const source = { items: [], exhausted: true, page: 4 };

    expect(
      applyConversationPage(
        source,
        conversationPage(['conversation-a'], 1, 3),
        'start',
      ),
    ).toMatchObject({ page: 4, exhausted: true });
  });
});
