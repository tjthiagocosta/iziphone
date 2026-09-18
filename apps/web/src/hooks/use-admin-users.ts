'use client';

import type {
  CreateUser,
  UpdateUser,
  UserListQuery,
  UserListResponse,
  UserResponse,
} from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  assignUserDepartment,
  assignUserPhoneNumber,
  deleteUser,
  getUser,
  getUsers,
  inviteUser,
  removeUserDepartment,
  removeUserPhoneNumber,
  resendUserInvite,
  restoreUser,
  sendUserPasswordReset,
  updateUser,
} from '@/lib/api/admin';

interface UseUsersOptions {
  initialQuery?: Partial<UserListQuery>;
  autoFetch?: boolean;
}

export function useUsers(options: UseUsersOptions = {}) {
  const { initialQuery = {}, autoFetch = true } = options;
  const [data, setData] = useState<UserListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(autoFetch);
  const [error, setError] = useState<Error | null>(null);
  const queryRef = useRef<Partial<UserListQuery>>(initialQuery);

  const fetchUsers = useCallback(async (newQuery?: Partial<UserListQuery>) => {
    try {
      setIsLoading(true);
      setError(null);
      const q = newQuery ?? queryRef.current;
      if (newQuery) {
        queryRef.current = newQuery;
      }
      const result = await getUsers(q);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch users'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoFetch) {
      fetchUsers();
    }
  }, [autoFetch, fetchUsers]);

  return {
    users: data?.users ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? 1,
    totalPages: data?.totalPages ?? 0,
    isLoading,
    error,
    query: queryRef.current,
    setQuery: fetchUsers,
    refetch: fetchUsers,
  };
}

export function useUser(userId: string | null) {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [isLoading, setIsLoading] = useState(!!userId);
  const [error, setError] = useState<Error | null>(null);

  const fetchUser = useCallback(async () => {
    if (!userId) {
      setUser(null);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await getUser(userId);
      setUser(data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch user'));
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  return { user, isLoading, error, refetch: fetchUser };
}

export function useUserMutations() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /** Creating a user invites them; the result carries the link to pass on. */
  const invite = useCallback(async (data: CreateUser) => {
    try {
      setIsLoading(true);
      setError(null);
      return await inviteUser(data);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to invite user');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resendInvite = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      return await resendUserInvite(id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to send the invite');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const sendPasswordReset = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      return await sendUserPasswordReset(id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to send the reset link');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const update = useCallback(async (id: string, data: UpdateUser) => {
    try {
      setIsLoading(true);
      setError(null);
      return await updateUser(id, data);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to update user');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      await deleteUser(id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to delete user');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /** Restoring re-invites them; the result carries the link to pass on. */
  const restore = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      return await restoreUser(id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to restore user');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const assignDepartment = useCallback(
    async (userId: string, departmentId: string, order: number) => {
      try {
        setIsLoading(true);
        setError(null);
        await assignUserDepartment(userId, { departmentId, order });
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to assign department');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const removeDepartment = useCallback(
    async (userId: string, departmentId: string) => {
      try {
        setIsLoading(true);
        setError(null);
        await removeUserDepartment(userId, departmentId);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to remove department');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const assignPhoneNumber = useCallback(
    async (userId: string, phoneNumberId: string) => {
      try {
        setIsLoading(true);
        setError(null);
        await assignUserPhoneNumber(userId, { phoneNumberId });
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error('Failed to assign phone number');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const removePhoneNumber = useCallback(
    async (userId: string, phoneNumberId: string) => {
      try {
        setIsLoading(true);
        setError(null);
        await removeUserPhoneNumber(userId, phoneNumberId);
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error('Failed to remove phone number');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  return {
    isLoading,
    error,
    invite,
    resendInvite,
    sendPasswordReset,
    update,
    remove,
    restore,
    assignDepartment,
    removeDepartment,
    assignPhoneNumber,
    removePhoneNumber,
  };
}
