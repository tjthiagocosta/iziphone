'use client';

import type { Contact, ContactListResponse } from '@repo/dto';
import { useCallback, useEffect, useState } from 'react';
import { listContacts } from '@/lib/api/user';

interface UseContactsOptions {
  search?: string;
  page?: number;
  limit?: number;
}

interface UseContactsReturn {
  contacts: Contact[];
  total: number;
  page: number;
  totalPages: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useContacts(
  options: UseContactsOptions = {},
): UseContactsReturn {
  const { search, page = 1, limit = 50 } = options;

  const [data, setData] = useState<ContactListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchContacts = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      setData(await listContacts({ search, page, limit }));
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch contacts'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [search, page, limit]);

  useEffect(() => {
    void fetchContacts();
  }, [fetchContacts]);

  return {
    contacts: data?.contacts ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? page,
    totalPages: data?.totalPages ?? 0,
    isLoading,
    error,
    refetch: fetchContacts,
  };
}
