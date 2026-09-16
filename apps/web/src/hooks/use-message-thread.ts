'use client';

import type { Message, MessageConversation } from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
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
const browserDeps: MessageThreadDeps = {
  fetchConversation: getMessageConversation,
  fetchMessages: getConversationMessages,
  markRead: markMessageConversationRead,
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

  useEffect(() => {
    if (!conversationId) {
      return;
    }

    const session = new MessageThreadSession(
      conversationId,
      browserDeps,
      setState,
    );
    sessionRef.current = session;
    session.start();

    return () => {
      session.dispose();
      sessionRef.current = null;
    };
  }, [conversationId]);

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
