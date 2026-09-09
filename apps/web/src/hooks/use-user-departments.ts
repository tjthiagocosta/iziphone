'use client';

import type { UserDepartmentItem } from '@repo/dto';
import { useCallback, useEffect, useState } from 'react';
import { getUserDepartments } from '@/lib/api/user';

interface UseUserDepartmentsOptions {
  autoFetch?: boolean;
}

interface UseUserDepartmentsReturn {
  departments: UserDepartmentItem[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useUserDepartments(
  options: UseUserDepartmentsOptions = {},
): UseUserDepartmentsReturn {
  const { autoFetch = true } = options;
  const [departments, setDepartments] = useState<UserDepartmentItem[]>([]);
  const [isLoading, setIsLoading] = useState(autoFetch);
  const [error, setError] = useState<Error | null>(null);

  const fetchDepartments = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await getUserDepartments();
      setDepartments(result.departments);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch departments'),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoFetch) {
      fetchDepartments();
    }
  }, [autoFetch, fetchDepartments]);

  return {
    departments,
    isLoading,
    error,
    refetch: fetchDepartments,
  };
}
