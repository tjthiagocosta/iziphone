'use client';

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

const PAGE_SIZE = 25;

/** Nothing pushes an inbound message to the browser, so an open tab looks. */
const POLL_MS = 30_000;

/**
 * The controller broadcasts `call_ended` and the API writes the history row
 * from the same Redis event, as two independent consumers. A short wait lets
 * the write land before the refetch reads.
 */
const CALL_HISTORY_DELAY_MS = 1000;

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
  const { lastEndedCall } = useCall();
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
  // Answers to a tab the user has already left are dropped.
  const requestRef = useRef(0);

  const load = useCallback(
    async (from: PageStart) => {
      const source = stateRef.current;
      const request = ++requestRef.current;

      try {
        const [calls, conversations] = await Promise.all([
          query.calls
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
        setError(null);
      } catch (cause) {
        if (request !== requestRef.current) {
          return;
        }
        setError(
          cause instanceof Error
            ? cause
            : new Error('The inbox failed to load'),
        );
      } finally {
        if (request === requestRef.current) {
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
