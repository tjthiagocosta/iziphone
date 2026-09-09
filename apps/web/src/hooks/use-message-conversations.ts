'use client';

import type {
  MessageConversationListItem,
  MessageConversationListResponse,
} from '@repo/dto';
import { useCallback, useEffect, useState } from 'react';
import { listMessageConversations } from '@/lib/api/user';

interface UseMessageConversationsOptions {
  search?: string;
  sourcePhoneNumberId?: string;
  page?: number;
  limit?: number;
  autoFetch?: boolean;
}

interface UseMessageConversationsReturn {
  conversations: MessageConversationListItem[];
  total: number;
  page: number;
  totalPages: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useMessageConversations(
  options: UseMessageConversationsOptions = {},
): UseMessageConversationsReturn {
  const {
    search,
    sourcePhoneNumberId,
    page = 1,
    limit = 20,
    autoFetch = true,
  } = options;

  const [data, setData] = useState<MessageConversationListResponse | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(autoFetch);
  const [error, setError] = useState<Error | null>(null);

  const fetchConversations = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await listMessageConversations({
        search,
        sourcePhoneNumberId,
        page,
        limit,
      });
      setData(result);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch conversations'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [search, sourcePhoneNumberId, page, limit]);

  useEffect(() => {
    if (autoFetch) {
      fetchConversations();
    }
  }, [autoFetch, fetchConversations]);

  return {
    conversations: data?.conversations ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? page,
    totalPages: data?.totalPages ?? 0,
    isLoading,
    error,
    refetch: fetchConversations,
  };
}
