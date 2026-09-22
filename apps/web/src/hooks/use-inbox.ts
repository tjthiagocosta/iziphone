'use client';

import type { MessageActivity } from '@repo/dto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { listCalls } from '@/lib/api/calls';
import { listMessageConversations } from '@/lib/api/user';
import {
  hasMoreInboxItems,
  type InboxItem,
  type InboxScope,
  type InboxTab,
  inboxQueryFor,
  visibleInboxItems,
} from '@/lib/inbox/inbox-item';
import {
  applyCallPage,
  applyConversationPage,
  type InboxState,
  initialInboxState,
  type PageStart,
} from '@/lib/inbox/inbox-paging';
import { ACTIVITY_REFRESH_DELAY_MS } from '@/lib/messaging/conversation-activity';

const PAGE_SIZE = 25;

/**
 * The safety net under the socket. A message reaches the inbox when the
 * controller pushes `message_activity`, so this is for the event that never
 * arrives — the socket was down, or a reconnect fell in the gap — and can be
 * slow. One poll every two minutes: a request a minute on a tab that lists
 * both calls and conversations, half that on a tab that lists one, against the
 * API's 100 a minute per client address that an office shares.
 */
const POLL_MS = 120_000;

/**
 * The controller broadcasts `call_ended` and the API writes the history row
 * from the same Redis event, as two independent consumers. A short wait lets
 * the write land before the refetch reads.
 */
const CALL_HISTORY_DELAY_MS = 1000;

/**
 * Which of the two lists a read covers. A notification names a conversation,
 * so it reads the conversations only: asking for the calls again would double
 * what a busy line costs and could not tell the reader anything new.
 */
type ReadLists = 'both' | 'conversations';

export interface UseInboxReturn {
  items: InboxItem[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

/**
 * The merged inbox: call history and message conversations, newest first.
 *
 * The tab decides which of the two lists is read and with what filter, so
 * every tab narrows in the database instead of over a loaded page. What is
 * rendered stops at the point both lists have covered (see `inboxWatermark`),
 * which keeps the next page below the rows already on screen.
 *
 * Pass a `scope` to read one line's inbox instead of everything the reader
 * can see; a department page is that same inbox on the department's number.
 */
export function useInbox(tab: InboxTab, scope?: InboxScope): UseInboxReturn {
  const { lastEndedCall, lastMessageActivity } = useCall();
  const linePhone = scope?.linePhone;
  const sourcePhoneNumberId = scope?.sourcePhoneNumberId ?? null;

  const query = useMemo(
    () =>
      inboxQueryFor(
        tab,
        linePhone ? { linePhone, sourcePhoneNumberId } : undefined,
      ),
    [tab, linePhone, sourcePhoneNumberId],
  );

  const [state, setState] = useState<InboxState>(() =>
    initialInboxState(query),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // The place each list has reached, read inside a request that must not be
  // re-created every time a page lands.
  const stateRef = useRef(state);
  stateRef.current = state;
  // Read when a waiting read starts rather than when it was asked for, so a
  // failure that lands in between is not what cancels it.
  const errorRef = useRef(error);
  errorRef.current = error;
  // Answers to a tab the user has already left are dropped.
  const requestRef = useRef(0);
  /**
   * The notice this inbox has already acted on. It starts at whatever the
   * socket last saw, because the notices before this inbox mounted are older
   * than the read that mounts it: the provider holding them outlives the page.
   */
  const handledActivity = useRef<MessageActivity | null>(lastMessageActivity);

  const load = useCallback(
    async (from: PageStart, lists: ReadLists = 'both') => {
      const source = stateRef.current;
      // A read of one list stands behind the reads that cover both instead of
      // taking their place: it lands beside an answer still on its way rather
      // than discarding it, and a later read of everything drops it. It is
      // also nobody's request, so it neither shows as loading nor reports a
      // failure: what is on screen stays, and the next read asks again.
      const partial = lists !== 'both';
      const request = partial ? requestRef.current : ++requestRef.current;

      try {
        const [calls, conversations] = await Promise.all([
          lists === 'both' && query.calls
            ? listCalls({
                ...query.calls,
                limit: PAGE_SIZE,
                offset: from === 'start' ? 0 : source.calls.offset,
              })
            : null,
          query.conversations
            ? listMessageConversations({
                ...query.conversations,
                limit: PAGE_SIZE,
                page: from === 'start' ? 1 : source.conversations.page,
              })
            : null,
        ]);

        if (request !== requestRef.current) {
          return;
        }

        setState((current) => ({
          calls: calls
            ? applyCallPage(current.calls, calls, from)
            : current.calls,
          conversations: conversations
            ? applyConversationPage(current.conversations, conversations)
            : current.conversations,
        }));
        if (!partial) {
          setError(null);
        }
      } catch (cause) {
        if (partial || request !== requestRef.current) {
          return;
        }
        setError(
          cause instanceof Error
            ? cause
            : new Error('The inbox failed to load'),
        );
      } finally {
        if (!partial && request === requestRef.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [query],
  );

  const refresh = useCallback(() => {
    void load('start');
  }, [load]);

  const loadMore = useCallback(() => {
    const sources = [stateRef.current.calls, stateRef.current.conversations];
    if (!hasMoreInboxItems(sources)) {
      return;
    }
    setIsLoadingMore(true);
    void load('next');
  }, [load]);

  // A new tab or line reads different lists; start empty rather than showing
  // the previous one's rows while the first page arrives.
  useEffect(() => {
    setState(initialInboxState(query));
    setIsLoading(true);
    void load('start');
  }, [query, load]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void load('start');
      }
    };

    const poll = window.setInterval(refreshWhenVisible, POLL_MS);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return () => {
      window.clearInterval(poll);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);

  // A conversation changed, so the inbox reads its conversations again. A burst
  // is one read: each event replaces the wait left by the one before it.
  //
  // Each notice is acted on once, and only where it can show: a tab that lists
  // no conversations has nothing to re-read, and a hidden tab is already read
  // again when the agent comes back to it.
  useEffect(() => {
    const activity = lastMessageActivity;
    if (!activity || activity === handledActivity.current) {
      return;
    }
    handledActivity.current = activity;
    if (!query.conversations || document.visibilityState !== 'visible') {
      return;
    }

    const timer = window.setTimeout(() => {
      // A failure is on screen instead of the rows, and only a read that
      // covers both lists can take it away: a partial one would leave the
      // inbox reporting a failure it has recovered from.
      void load('start', errorRef.current ? 'both' : 'conversations');
    }, ACTIVITY_REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lastMessageActivity, query.conversations, load]);

  useEffect(() => {
    if (!lastEndedCall) {
      return;
    }
    const timer = window.setTimeout(() => {
      void load('start');
    }, CALL_HISTORY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lastEndedCall, load]);

  return {
    items: visibleInboxItems([state.calls, state.conversations]),
    isLoading,
    isLoadingMore,
    error,
    hasMore: hasMoreInboxItems([state.calls, state.conversations]),
    loadMore,
    refresh,
  };
}
