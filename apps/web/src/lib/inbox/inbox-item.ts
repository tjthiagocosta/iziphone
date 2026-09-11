import type {
  CallListQuery,
  CallRecord,
  MessageConversationListItem,
  MessageConversationListQuery,
} from '@repo/dto';
import { watermarkOf } from '../paging';

/**
 * One row of the inbox. Calls and message conversations are separate lists in
 * the API with nothing in common but a timestamp, so they meet here rather
 * than in the view.
 */
export type InboxItem =
  | { kind: 'call'; key: string; sortKey: number; call: CallRecord }
  | {
      kind: 'conversation';
      key: string;
      sortKey: number;
      conversation: MessageConversationListItem;
    };

export type InboxTab =
  | 'all'
  | 'unread'
  | 'calls'
  | 'missed'
  | 'voicemails'
  | 'messages';

/** Statuses that mean nobody picked up, for the Missed tab and its styling. */
export const MISSED_CALL_STATUSES = ['missed', 'no-answer', 'busy'] as const;

export function isMissedCall(call: Pick<CallRecord, 'status'>): boolean {
  return MISSED_CALL_STATUSES.some((status) => status === call.status);
}

/**
 * Milliseconds since the epoch, or null when the value is not a time.
 *
 * The inbox sorts on this rather than on the string: `IsoDateTimeSchema`
 * admits offset forms, and `2026-03-20T00:00:00+02:00` sorts after
 * `2026-03-20T01:00:00Z` lexicographically while being an hour earlier.
 */
function epochOf(value: string): number | null {
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : epoch;
}

export function callInboxItem(call: CallRecord): InboxItem | null {
  const sortKey = epochOf(call.createdAt);
  return sortKey === null
    ? null
    : { kind: 'call', key: `call:${call.id}`, sortKey, call };
}

/**
 * A conversation nobody has messaged yet has no place on a list ordered by
 * recency, and Postgres sorts its null `lastMessageAt` first, which is the
 * opposite end from where the client would put it. Leave it out.
 */
export function conversationInboxItem(
  conversation: MessageConversationListItem,
): InboxItem | null {
  const sortKey = conversation.lastMessageAt
    ? epochOf(conversation.lastMessageAt)
    : null;

  return sortKey === null
    ? null
    : {
        kind: 'conversation',
        key: `conversation:${conversation.id}`,
        sortKey,
        conversation,
      };
}

/** Newest first, with a stable tie-break so equal timestamps keep an order. */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  if (a.sortKey !== b.sortKey) {
    return b.sortKey - a.sortKey;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Adds a freshly loaded page to what a source already holds.
 *
 * Both lists page by position, so a call or message that arrives between two
 * requests shifts every later row down and repeats one across the boundary.
 * Keying on the row's id drops the repeat.
 */
export function mergeInboxPage(
  loaded: readonly InboxItem[],
  page: readonly InboxItem[],
): InboxItem[] {
  const byKey = new Map(loaded.map((item) => [item.key, item]));
  for (const item of page) {
    byKey.set(item.key, item);
  }
  return [...byKey.values()].sort(compareInboxItems);
}

/** What one of the two lists has loaded so far. */
export interface InboxSource {
  items: readonly InboxItem[];
  /** Nothing older than `items` is left to fetch. */
  exhausted: boolean;
}

/** The oldest timestamp the inbox can show without leaving a hole. */
export function inboxWatermark(sources: readonly InboxSource[]): number {
  return watermarkOf(
    sources.map((source) => ({
      oldest: source.items[source.items.length - 1]?.sortKey ?? null,
      exhausted: source.exhausted,
    })),
  );
}

/** The merged rows that are safe to render, newest first. */
export function visibleInboxItems(
  sources: readonly InboxSource[],
): InboxItem[] {
  const watermark = inboxWatermark(sources);

  return sources
    .flatMap((source) => source.items)
    .filter((item) => item.sortKey >= watermark)
    .sort(compareInboxItems);
}

/** True while a source could still yield a row the inbox is not showing. */
export function hasMoreInboxItems(sources: readonly InboxSource[]): boolean {
  return sources.some((source) => !source.exhausted);
}

/**
 * Which lists a tab reads, and with what filter; null means the tab ignores
 * that list. Every tab narrows in the database rather than over a loaded
 * page, so a tab whose rows are rare still fills and pages correctly.
 */
export interface InboxQuery {
  calls: Partial<CallListQuery> | null;
  conversations: Partial<MessageConversationListQuery> | null;
}

/**
 * One of our numbers, when the inbox is a line's rather than the reader's.
 * The two lists identify a line differently: call history knows only the
 * numbers on the legs, message conversations hold the phone number row.
 */
export interface InboxScope {
  linePhone: string;
  /**
   * The phone number row. Null for a line that carries no messages, which
   * has no conversations to read either.
   */
  sourcePhoneNumberId: string | null;
}

export function inboxQueryFor(tab: InboxTab, scope?: InboxScope): InboxQuery {
  const query = tabQuery(tab);

  if (!scope) {
    return query;
  }

  const sourcePhoneNumberId = scope.sourcePhoneNumberId;

  return {
    calls: query.calls && { ...query.calls, linePhone: scope.linePhone },
    conversations:
      query.conversations && sourcePhoneNumberId
        ? { ...query.conversations, sourcePhoneNumberId }
        : null,
  };
}

function tabQuery(tab: InboxTab): InboxQuery {
  switch (tab) {
    case 'unread':
      // `Call` keeps no read state, so unread is a message idea only.
      return { calls: null, conversations: { unreadOnly: true } };
    case 'calls':
      return { calls: {}, conversations: null };
    case 'missed':
      return {
        calls: { status: [...MISSED_CALL_STATUSES] },
        conversations: null,
      };
    case 'voicemails':
      return { calls: { hasVoicemail: true }, conversations: null };
    case 'messages':
      return { calls: null, conversations: {} };
    default:
      return { calls: {}, conversations: {} };
  }
}
