'use client';

import type {
  AvailablePhoneNumber,
  PhoneNumberListQuery,
  PhoneNumberListResponse,
  PhoneNumberResponse,
  PurchasePhoneNumber,
  SearchAvailableNumbers,
  UpdatePhoneNumber,
} from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPhoneNumber,
  getPhoneNumbers,
  purchasePhoneNumber,
  releasePhoneNumber,
  searchAvailableNumbers,
  updatePhoneNumber,
} from '@/lib/api/admin';

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

  const fetchPhoneNumbers = useCallback(
    async (newQuery?: Partial<PhoneNumberListQuery>) => {
      try {
        setIsLoading(true);
        setError(null);
        const q = newQuery ?? queryRef.current;
        if (newQuery) {
          queryRef.current = newQuery;
        }
        const result = await getPhoneNumbers(q);
        setData(result);
      } catch (err) {
        setError(
          err instanceof Error
            ? err
            : new Error('Failed to fetch phone numbers'),
        );
      } finally {
        setIsLoading(false);
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

  const fetchPhoneNumber = useCallback(async () => {
    if (!phoneNumberId) {
      setPhoneNumber(null);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await getPhoneNumber(phoneNumberId);
      setPhoneNumber(data);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch phone number'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [phoneNumberId]);

  useEffect(() => {
    fetchPhoneNumber();
  }, [fetchPhoneNumber]);

  return { phoneNumber, isLoading, error, refetch: fetchPhoneNumber };
}

export function useAvailableNumbers() {
  const [numbers, setNumbers] = useState<AvailablePhoneNumber[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const search = useCallback(async (query: SearchAvailableNumbers) => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await searchAvailableNumbers(query);
      setNumbers(result.numbers);
    } catch (err) {
      setError(
        err instanceof Error
          ? err
          : new Error('Failed to search available numbers'),
      );
      setNumbers([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setNumbers([]);
    setError(null);
  }, []);

  return { numbers, isLoading, error, search, reset };
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

  const release = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      await releasePhoneNumber(id);
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

  return {
    isLoading,
    error,
    purchase,
    update,
    release,
  };
}
