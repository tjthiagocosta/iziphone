'use client';

import type { Message, MessageConversation } from '@repo/dto';
import { useCallback, useEffect, useState } from 'react';
import {
  getConversationMessages,
  getMessageConversation,
  markMessageConversationRead,
} from '@/lib/api/user';

interface UseMessageThreadOptions {
  autoFetch?: boolean;
  autoMarkRead?: boolean;
}

interface UseMessageThreadReturn {
  conversation: MessageConversation | null;
  /** Oldest first, the order a thread is read in. */
  messages: Message[];
  hasMore: boolean;
  isLoading: boolean;
  error: Error | null;
  loadOlder: () => Promise<void>;
  refetch: () => Promise<void>;
}

export function useMessageThread(
  conversationId: string | null,
  options: UseMessageThreadOptions = {},
): UseMessageThreadReturn {
  const { autoFetch = true, autoMarkRead = true } = options;

  const [conversation, setConversation] = useState<MessageConversation | null>(
    null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(
    autoFetch && Boolean(conversationId),
  );
  const [error, setError] = useState<Error | null>(null);

  const fetchThread = useCallback(async () => {
    if (!conversationId) return;

    try {
      setIsLoading(true);
      setError(null);

      const [conv, messageResult] = await Promise.all([
        getMessageConversation(conversationId),
        getConversationMessages(conversationId),
      ]);

      setConversation(conv);
      // The endpoint answers newest first, because it pages backwards.
      setMessages([...messageResult.messages].reverse());
      setHasMore(messageResult.hasMore);

      if (autoMarkRead && conv.unreadCount > 0) {
        await markMessageConversationRead(conversationId);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch thread'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [conversationId, autoMarkRead]);

  useEffect(() => {
    if (autoFetch && conversationId) {
      fetchThread();
    }
  }, [autoFetch, conversationId, fetchThread]);

  const loadOlder = useCallback(async () => {
    if (!conversationId || !messages.length || !hasMore) return;

    try {
      const oldestMessage = messages[0];
      if (!oldestMessage) return;
      const result = await getConversationMessages(conversationId, {
        beforeMessageId: oldestMessage.id,
      });

      setMessages((prev) => [...[...result.messages].reverse(), ...prev]);
      setHasMore(result.hasMore);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to load older messages'),
      );
    }
  }, [conversationId, messages, hasMore]);

  return {
    conversation,
    messages,
    hasMore,
    isLoading,
    error,
    loadOlder,
    refetch: fetchThread,
  };
}
