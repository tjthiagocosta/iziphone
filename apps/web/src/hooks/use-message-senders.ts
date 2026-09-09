'use client';

import type { MessageSender } from '@repo/dto';
import { useCallback, useEffect, useState } from 'react';
import { getMessageSenders } from '@/lib/api/user';

interface UseMessageSendersReturn {
  senders: MessageSender[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useMessageSenders(): UseMessageSendersReturn {
  const [senders, setSenders] = useState<MessageSender[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSenders = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await getMessageSenders();
      setSenders(result.senders);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch senders'),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSenders();
  }, [fetchSenders]);

  return { senders, isLoading, error, refetch: fetchSenders };
}
