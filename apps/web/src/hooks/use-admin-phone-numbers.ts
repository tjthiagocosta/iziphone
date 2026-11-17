'use client';

import type {
  AvailablePhoneNumber,
  ImportPhoneNumber,
  MonthlyPrice,
  OwnedPhoneNumbersResponse,
  PhoneNumberConnection,
  PhoneNumberListQuery,
  PhoneNumberListResponse,
  PhoneNumberResponse,
  PurchasePhoneNumber,
  SearchAvailableNumbers,
  SetMessagingService,
  UpdatePhoneNumber,
} from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getOwnedPhoneNumbers,
  getPhoneNumber,
  getPhoneNumberConnection,
  getPhoneNumbers,
  importPhoneNumber,
  purchasePhoneNumber,
  reconnectPhoneNumber,
  releasePhoneNumber,
  searchAvailableNumbers,
  setPhoneNumberMessagingService,
  updatePhoneNumber,
} from '@/lib/api/admin';
import { ApiError } from '@/lib/api/client';
import { lastPageIfPastEnd } from '@/lib/phone-numbers/list-page';
import { addFoundNumbers } from '@/lib/phone-numbers/number-search';

interface UsePhoneNumbersOptions {
  initialQuery?: Partial<PhoneNumberListQuery>;
  autoFetch?: boolean;
}

export function usePhoneNumbers(options: UsePhoneNumbersOptions = {}) {
  const { initialQuery = {}, autoFetch = true } = options;
  const [data, setData] = useState<PhoneNumberListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(autoFetch);
  const [error, setError] = useState<Error | null>(null);
  const queryRef = useRef<Partial<PhoneNumberListQuery>>(initialQuery);
  // A reload and a new search can overlap; only the latest one counts.
  const latest = useRef(0);

  const fetchPhoneNumbers = useCallback(
    async (newQuery?: Partial<PhoneNumberListQuery>) => {
      const request = ++latest.current;

      try {
        setIsLoading(true);
        setError(null);
        const q = newQuery ?? queryRef.current;
        if (newQuery) {
          queryRef.current = newQuery;
        }
        const asked = await getPhoneNumbers(q);
        if (request !== latest.current) return;

        const lastPage = lastPageIfPastEnd(q.page ?? 1, asked.totalPages);

        if (lastPage === null) {
          setData(asked);
          return;
        }

        queryRef.current = { ...q, page: lastPage };
        const lastPageData = await getPhoneNumbers(queryRef.current);
        if (request === latest.current) {
          setData(lastPageData);
        }
      } catch (err) {
        if (request === latest.current) {
          setError(
            err instanceof Error
              ? err
              : new Error('Failed to fetch phone numbers'),
          );
        }
      } finally {
        if (request === latest.current) {
          setIsLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (autoFetch) {
      fetchPhoneNumbers();
    }
  }, [autoFetch, fetchPhoneNumbers]);

  return {
    phoneNumbers: data?.phoneNumbers ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? 1,
    totalPages: data?.totalPages ?? 0,
    isLoading,
    error,
    query: queryRef.current,
    setQuery: fetchPhoneNumbers,
    refetch: fetchPhoneNumbers,
  };
}

export function usePhoneNumber(phoneNumberId: string | null) {
  const [phoneNumber, setPhoneNumber] = useState<PhoneNumberResponse | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(!!phoneNumberId);
  const [error, setError] = useState<Error | null>(null);
  // A read of the number shown before must not land on the one shown now.
  const latest = useRef(0);

  const fetchPhoneNumber = useCallback(async () => {
    const request = ++latest.current;

    if (!phoneNumberId) {
      setPhoneNumber(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await getPhoneNumber(phoneNumberId);
      if (request === latest.current) {
        setPhoneNumber(data);
      }
    } catch (err) {
      if (request !== latest.current) return;

      // A number released or removed meanwhile must not stay on screen.
      if (err instanceof ApiError && err.status === 404) {
        setPhoneNumber(null);
      }
      setError(
        err instanceof Error ? err : new Error('Failed to fetch phone number'),
      );
    } finally {
      if (request === latest.current) {
        setIsLoading(false);
      }
    }
  }, [phoneNumberId]);

  useEffect(() => {
    fetchPhoneNumber();
  }, [fetchPhoneNumber]);

  return { phoneNumber, isLoading, error, refetch: fetchPhoneNumber };
}

/**
 * Whether the number's calls and texts reach this deployment, asked of
 * Twilio each time it is fetched.
 */
export function usePhoneNumberConnection(phoneNumberId: string | null) {
  const [connection, setConnection] = useState<PhoneNumberConnection | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(!!phoneNumberId);
  const [error, setError] = useState<Error | null>(null);
  // A check of the number shown before must not land on the one shown now.
  const latest = useRef(0);

  const fetchConnection = useCallback(async () => {
    const request = ++latest.current;

    if (!phoneNumberId) {
      setConnection(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await getPhoneNumberConnection(phoneNumberId);
      if (request === latest.current) {
        setConnection(data);
      }
    } catch (err) {
      if (request !== latest.current) return;

      setConnection(null);
      setError(
        err instanceof Error
          ? err
          : new Error('Failed to check the number with Twilio'),
      );
    } finally {
      if (request === latest.current) {
        setIsLoading(false);
      }
    }
  }, [phoneNumberId]);

  useEffect(() => {
    fetchConnection();
  }, [fetchConnection]);

  return { connection, isLoading, error, refetch: fetchConnection };
}

/** The numbers the Twilio account holds that are not in the list, read while `enabled`. */
export function useOwnedNumbers(enabled: boolean) {
  const [data, setData] = useState<OwnedPhoneNumbersResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // A read answered after the dialog closed, or after a newer read, must not land.
  const latest = useRef(0);

  const fetchOwned = useCallback(async () => {
    const request = ++latest.current;

    try {
      setIsLoading(true);
      setError(null);
      const owned = await getOwnedPhoneNumbers();
      if (request === latest.current) {
        setData(owned);
      }
    } catch (err) {
      if (request !== latest.current) return;

      setData(null);
      setError(
        err instanceof Error
          ? err
          : new Error('Failed to list the numbers on the Twilio account'),
      );
    } finally {
      if (request === latest.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      fetchOwned();
      return;
    }

    latest.current++;
    setData(null);
    setError(null);
    setIsLoading(false);
  }, [enabled, fetchOwned]);

  return {
    numbers: data?.numbers ?? [],
    truncated: data?.truncated ?? false,
    isLoading,
    error,
    refetch: fetchOwned,
  };
}

export function useAvailableNumbers() {
  const [numbers, setNumbers] = useState<AvailablePhoneNumber[]>([]);
  const [monthlyPrice, setMonthlyPrice] = useState<MonthlyPrice | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  /** How many new numbers the last "show more" added; null after a fresh search. */
  const [addedByMore, setAddedByMore] = useState<number | null>(null);
  // What a "show more" adds to, kept in step with `numbers`.
  const shown = useRef<AvailablePhoneNumber[]>([]);
  // A search answered after a newer one, or after a reset, must not land.
  const latest = useRef(0);

  const run = useCallback(
    async (query: SearchAvailableNumbers, more: boolean) => {
      const request = ++latest.current;

      try {
        setIsLoading(!more);
        setIsLoadingMore(more);
        setError(null);
        setAddedByMore(null);
        const result = await searchAvailableNumbers(query);
        if (request !== latest.current) return;

        const found = addFoundNumbers(
          more ? shown.current : [],
          result.numbers,
        );
        shown.current = found.numbers;
        setNumbers(found.numbers);
        setAddedByMore(more ? found.added : null);
        // A price list that failed to load this time does not unsay the last one.
        setMonthlyPrice((previous) =>
          more ? (result.monthlyPrice ?? previous) : result.monthlyPrice,
        );
      } catch (err) {
        if (request !== latest.current) return;

        setError(
          err instanceof Error
            ? err
            : new Error('Failed to search available numbers'),
        );
        // A failed "show more" keeps the numbers already found.
        if (!more) {
          shown.current = [];
          setNumbers([]);
          setMonthlyPrice(null);
        }
      } finally {
        if (request === latest.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [],
  );

  /** A fresh search: its numbers replace the ones on show. */
  const search = useCallback(
    (query: SearchAvailableNumbers) => run(query, false),
    [run],
  );

  /** The same search again, adding the numbers it finds to the ones on show. */
  const searchMore = useCallback(
    (query: SearchAvailableNumbers) => run(query, true),
    [run],
  );

  const reset = useCallback(() => {
    latest.current++;
    shown.current = [];
    setIsLoading(false);
    setIsLoadingMore(false);
    setNumbers([]);
    setMonthlyPrice(null);
    setError(null);
    setAddedByMore(null);
  }, []);

  return {
    numbers,
    monthlyPrice,
    isLoading,
    isLoadingMore,
    error,
    addedByMore,
    search,
    searchMore,
    reset,
  };
}

export function usePhoneNumberMutations() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const purchase = useCallback(async (data: PurchasePhoneNumber) => {
    try {
      setIsLoading(true);
      setError(null);
      return await purchasePhoneNumber(data);
    } catch (err) {
      const error =
        err instanceof Error
          ? err
          : new Error('Failed to purchase phone number');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const importNumber = useCallback(async (data: ImportPhoneNumber) => {
    try {
      setIsLoading(true);
      setError(null);
      return await importPhoneNumber(data);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to add phone number');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const update = useCallback(async (id: string, data: UpdatePhoneNumber) => {
    try {
      setIsLoading(true);
      setError(null);
      return await updatePhoneNumber(id, data);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to update phone number');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reconnect = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      return await reconnectPhoneNumber(id);
    } catch (err) {
      const error =
        err instanceof Error
          ? err
          : new Error('Failed to reconnect phone number');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setMessagingService = useCallback(
    async (id: string, data: SetMessagingService) => {
      try {
        setIsLoading(true);
        setError(null);
        return await setPhoneNumberMessagingService(id, data);
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error('Failed to change the messaging service');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const release = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      return await releasePhoneNumber(id);
    } catch (err) {
      const error =
        err instanceof Error
          ? err
          : new Error('Failed to release phone number');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    isLoading,
    error,
    purchase,
    importNumber,
    update,
    reconnect,
    setMessagingService,
    release,
    clearError,
  };
}
