'use client';

import type { Message, MessageActivity, MessageConversation } from '@repo/dto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { useUnreadMessages } from '@/components/providers/UnreadMessagesProvider';
import {
  getConversationMessages,
  getMessageConversation,
  markMessageConversationRead,
} from '@/lib/api/user';
import {
  type MessageThreadDeps,
  MessageThreadSession,
  type MessageThreadState,
  shownThread,
} from '@/lib/conversation/message-thread-session';
import { ACTIVITY_REFRESH_DELAY_MS } from '@/lib/messaging/conversation-activity';

interface UseMessageThreadReturn {
  conversation: MessageConversation | null;
  /** Oldest first, the order a thread is read in. */
  messages: readonly Message[];
  hasMore: boolean;
  isLoading: boolean;
  error: Error | null;
  /** Goes up when the thread starts over from its newest page; see the session. */
  restarts: number;
  loadOlder: () => Promise<void>;
  /** For after a send: reads the thread again without disturbing what is on screen. */
  refresh: () => Promise<void>;
}

/*
 * `document` is only reached when a session calls these, which happens inside
 * an effect: a client component is prerendered on the server as well, where
 * there is no page to ask.
 */
const browserDeps: Omit<MessageThreadDeps, 'markRead'> = {
  fetchConversation: getMessageConversation,
  fetchMessages: getConversationMessages,
  isVisible: () => document.visibilityState === 'visible',
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

/** Runs a message thread session for the open conversation and mirrors its state into React. */
export function useMessageThread(
  conversationId: string | null,
): UseMessageThreadReturn {
  const [state, setState] = useState<MessageThreadState | null>(null);
  const sessionRef = useRef<MessageThreadSession | null>(null);
  const { lastMessageActivity } = useCall();
  const { refresh: refreshUnreadTotal } = useUnreadMessages();

  // Read inside deps that must outlive the render they were built in, so the
  // session is not torn down and rebuilt when a callback's identity changes.
  const refreshUnreadTotalRef = useRef(refreshUnreadTotal);
  refreshUnreadTotalRef.current = refreshUnreadTotal;

  const deps = useMemo<MessageThreadDeps>(
    () => ({
      ...browserDeps,
      markRead: async (id) => {
        await markMessageConversationRead(id);
        // The thread just stopped being one of the unread ones.
        refreshUnreadTotalRef.current();
      },
    }),
    [],
  );

  /**
   * The notice this thread has already acted on. It starts at whatever the
   * socket last saw, because the notices before this thread opened are older
   * than the load that opens it: the provider holding them outlives the page.
   */
  const handledActivity = useRef<MessageActivity | null>(lastMessageActivity);
  /**
   * The wait between a notice about this thread and the read it causes. It is
   * held here rather than in the effect that starts it, because a notice about
   * another conversation must not be allowed to cancel it.
   */
  const pendingRead = useRef<number | null>(null);
  const cancelPendingRead = useCallback(() => {
    if (pendingRead.current !== null) {
      window.clearTimeout(pendingRead.current);
      pendingRead.current = null;
    }
  }, []);

  useEffect(() => {
    if (!conversationId) {
      return;
    }

    const session = new MessageThreadSession(conversationId, deps, setState);
    sessionRef.current = session;
    session.start();

    return () => {
      session.dispose();
      sessionRef.current = null;
      cancelPendingRead();
    };
  }, [conversationId, deps, cancelPendingRead]);

  // The open thread changed, so it reads its newest page and its header again
  // instead of waiting for the interval. A burst about this thread is one read:
  // each notice replaces the wait left by the one before it.
  //
  // Notices about the rest of the inbox arrive here too, on a shared line as
  // often as this thread's own. They are passed over without disturbing a read
  // this thread is already waiting to make.
  //
  // Each notice is acted on once, whatever else re-runs this: opening the
  // thread a notice named already reads it, and reading it again on the way in
  // would be a second request for nothing.
  useEffect(() => {
    const activity = lastMessageActivity;
    if (!activity || activity === handledActivity.current) {
      return;
    }
    handledActivity.current = activity;
    if (activity.conversationId !== conversationId) {
      return;
    }

    cancelPendingRead();
    pendingRead.current = window.setTimeout(() => {
      pendingRead.current = null;
      void sessionRef.current?.refresh();
    }, ACTIVITY_REFRESH_DELAY_MS);
  }, [lastMessageActivity, conversationId, cancelPendingRead]);

  const loadOlder = useCallback(
    () => sessionRef.current?.loadOlder() ?? Promise.resolve(),
    [],
  );
  const refresh = useCallback(
    () => sessionRef.current?.refresh() ?? Promise.resolve(),
    [],
  );

  const thread = shownThread(state, conversationId);

  return {
    conversation: thread.conversation,
    messages: thread.messages,
    hasMore: thread.hasMore,
    isLoading: thread.isLoading,
    error: thread.error,
    restarts: thread.restarts,
    loadOlder,
    refresh,
  };
}
