'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { getUnreadMessageSummary } from '@/lib/api/user';
import {
  ACTIVITY_REFRESH_DELAY_MS,
  openThreadIdOf,
  shouldRefreshUnreadCount,
} from '@/lib/messaging/conversation-activity';
import { useAuth } from './AuthProvider';

/*
 * How many conversations the signed-in user has unread. One number for the
 * whole app, because it is what the browser tab shows: whichever view is open,
 * and whichever line or tab it is filtered to, the count is everything the
 * reader can see.
 *
 * It is shared rather than fetched per view because everything that changes it
 * happens somewhere else: a message arrives over the socket, the inbox polls,
 * or a thread the reader opened is marked read.
 */

export interface UnreadMessagesValue {
  unreadConversations: number;
  /** Reads the count again. Callers do not wait on it. */
  refresh: () => void;
}

const UnreadMessagesContext = createContext<UnreadMessagesValue | null>(null);

export function UnreadMessagesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { lastMessageActivity } = useCall();
  const pathname = usePathname();
  const [unreadConversations, setUnreadConversations] = useState(0);
  const userId = user?.id;
  // Answers to a read the reader has since signed out of are dropped.
  const requestRef = useRef(0);
  // Where the reader is when a read comes due, not where they were when it was
  // asked for, and held in a ref so moving between pages does not disturb one
  // already waiting.
  const openThreadIdRef = useRef<string | null>(null);
  openThreadIdRef.current = openThreadIdOf(pathname);

  const refresh = useCallback(() => {
    if (!userId) {
      return;
    }

    const request = ++requestRef.current;
    getUnreadMessageSummary().then(
      (summary) => {
        if (request === requestRef.current) {
          setUnreadConversations(summary.unreadConversations);
        }
      },
      () => {
        // The count on screen stays as it was; the next event or poll asks
        // again. A number in a tab title is not worth an error anywhere.
      },
    );
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setUnreadConversations(0);
      return;
    }
    refresh();
  }, [userId, refresh]);

  // A burst of activity is one read: each event replaces the wait left by the
  // one before it.
  useEffect(() => {
    const activity = lastMessageActivity;
    if (!activity) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (
        shouldRefreshUnreadCount({
          kind: activity.kind,
          conversationId: activity.conversationId,
          openThreadId: openThreadIdRef.current,
          isPageVisible: document.visibilityState === 'visible',
        })
      ) {
        refresh();
      }
    }, ACTIVITY_REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lastMessageActivity, refresh]);

  return (
    <UnreadMessagesContext.Provider value={{ unreadConversations, refresh }}>
      {children}
    </UnreadMessagesContext.Provider>
  );
}

export function useUnreadMessages(): UnreadMessagesValue {
  const context = useContext(UnreadMessagesContext);
  if (!context) {
    throw new Error(
      'useUnreadMessages must be used within UnreadMessagesProvider',
    );
  }
  return context;
}
