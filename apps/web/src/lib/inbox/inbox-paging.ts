import type {
  CallListResponse,
  MessageConversationListResponse,
} from '@repo/dto';
import {
  callInboxItem,
  conversationInboxItem,
  type InboxItem,
  type InboxQuery,
  type InboxSource,
  mergeInboxPage,
} from './inbox-item';

/**
 * How much of each list the inbox holds.
 *
 * The two lists page differently — calls by offset, conversations by page
 * number — so each keeps its own place. `exhausted` starts true for a list
 * this inbox does not read, which lets the watermark ignore it.
 */
export interface InboxState {
  calls: InboxSource & { offset: number };
  conversations: InboxSource & { page: number };
}

/** Whether a request continues where the last one stopped or starts over. */
export type PageStart = 'start' | 'next';

/**
 * Takes the query rather than the tab: which lists are read depends on the
 * scope as well (a line that carries no messages reads none), and a source
 * left unexhausted that is never loaded holds the watermark at infinity and
 * hides every row the other list did load.
 */
export function initialInboxState(query: InboxQuery): InboxState {
  return {
    calls: { items: [], exhausted: query.calls === null, offset: 0 },
    conversations: {
      items: [],
      exhausted: query.conversations === null,
      page: 1,
    },
  };
}

function present(item: InboxItem | null): item is InboxItem {
  return item !== null;
}

/**
 * Folds a page of calls into what is already loaded.
 *
 * A refresh re-reads the newest page, so the offset only ever moves forward:
 * rows that arrived since the last request have pushed everything down, and
 * asking again from a position already passed repeats rows (which merging
 * drops) rather than skipping them.
 */
export function applyCallPage(
  source: InboxState['calls'],
  response: CallListResponse,
  from: PageStart,
): InboxState['calls'] {
  const reached =
    (from === 'start' ? 0 : source.offset) + response.calls.length;
  const offset = Math.max(source.offset, reached);

  return {
    items: mergeInboxPage(
      source.items,
      response.calls.map(callInboxItem).filter(present),
    ),
    exhausted:
      response.calls.length < response.limit || offset >= response.total,
    offset,
  };
}

/**
 * Folds a page of conversations into what is already loaded. Which page was
 * asked for is in the response, so unlike the call list this does not need to
 * be told whether the request restarted.
 */
export function applyConversationPage(
  source: InboxState['conversations'],
  response: MessageConversationListResponse,
): InboxState['conversations'] {
  const page = Math.max(source.page, response.page + 1);

  return {
    items: mergeInboxPage(
      source.items,
      response.conversations.map(conversationInboxItem).filter(present),
    ),
    exhausted: page > response.totalPages,
    page,
  };
}
