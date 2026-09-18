'use client';

import type {
  AddAgent,
  BusinessHoursItem,
  CreateDepartment,
  CreateHoliday,
  DepartmentListQuery,
  DepartmentListResponse,
  DepartmentResponse,
  UpdateAgentOrder,
  UpdateDepartment,
  UpdateDepartmentSettings,
  UpdateHoliday,
} from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addDepartmentAgent,
  addHoliday,
  assignDepartmentPhoneNumber,
  createDepartment,
  deleteDepartment,
  deleteHoliday,
  getDepartment,
  getDepartments,
  removeDepartmentAgent,
  removeDepartmentGreeting,
  removeDepartmentPhoneNumber,
  restoreDepartment,
  updateAgentOrder,
  updateBusinessHours,
  updateDepartment,
  updateDepartmentSettings,
  updateHoliday,
  uploadDepartmentGreeting,
} from '@/lib/api/admin';

interface UseDepartmentsOptions {
  initialQuery?: Partial<DepartmentListQuery>;
  autoFetch?: boolean;
}

export function useDepartments(options: UseDepartmentsOptions = {}) {
  const { initialQuery = {}, autoFetch = true } = options;
  const [data, setData] = useState<DepartmentListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(autoFetch);
  const [error, setError] = useState<Error | null>(null);
  const queryRef = useRef<Partial<DepartmentListQuery>>(initialQuery);

  const fetchDepartments = useCallback(
    async (newQuery?: Partial<DepartmentListQuery>) => {
      try {
        setIsLoading(true);
        setError(null);
        const q = newQuery ?? queryRef.current;
        if (newQuery) {
          queryRef.current = newQuery;
        }
        const result = await getDepartments(q);
        setData(result);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('Failed to fetch departments'),
        );
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (autoFetch) {
      fetchDepartments();
    }
  }, [autoFetch, fetchDepartments]);

  return {
    departments: data?.departments ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? 1,
    totalPages: data?.totalPages ?? 0,
    isLoading,
    error,
    query: queryRef.current,
    setQuery: fetchDepartments,
    refetch: fetchDepartments,
  };
}

export function useDepartment(departmentId: string | null) {
  const [department, setDepartment] = useState<DepartmentResponse | null>(null);
  const [isLoading, setIsLoading] = useState(!!departmentId);
  const [error, setError] = useState<Error | null>(null);

  const fetchDepartment = useCallback(async () => {
    if (!departmentId) {
      setDepartment(null);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await getDepartment(departmentId);
      setDepartment(data);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch department'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [departmentId]);

  useEffect(() => {
    fetchDepartment();
  }, [fetchDepartment]);

  return { department, isLoading, error, refetch: fetchDepartment };
}

export function useDepartmentMutations() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const create = useCallback(async (data: CreateDepartment) => {
    try {
      setIsLoading(true);
      setError(null);
      return await createDepartment(data);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to create department');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const update = useCallback(async (id: string, data: UpdateDepartment) => {
    try {
      setIsLoading(true);
      setError(null);
      return await updateDepartment(id, data);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to update department');
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
      await deleteDepartment(id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to delete department');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const restore = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      return await restoreDepartment(id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to restore department');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const updateSettings = useCallback(
    async (id: string, data: UpdateDepartmentSettings) => {
      try {
        setIsLoading(true);
        setError(null);
        await updateDepartmentSettings(id, data);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to update settings');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const uploadGreeting = useCallback(async (id: string, file: Blob) => {
    try {
      setIsLoading(true);
      setError(null);
      return await uploadDepartmentGreeting(id, file);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to upload greeting');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const removeGreeting = useCallback(async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      await removeDepartmentGreeting(id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to remove greeting');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setBusinessHours = useCallback(
    async (id: string, hours: BusinessHoursItem[]) => {
      try {
        setIsLoading(true);
        setError(null);
        await updateBusinessHours(id, hours);
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error('Failed to update business hours');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const createHoliday = useCallback(
    async (departmentId: string, data: CreateHoliday) => {
      try {
        setIsLoading(true);
        setError(null);
        return await addHoliday(departmentId, data);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to create holiday');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const editHoliday = useCallback(
    async (departmentId: string, holidayId: string, data: UpdateHoliday) => {
      try {
        setIsLoading(true);
        setError(null);
        await updateHoliday(departmentId, holidayId, data);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to update holiday');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const removeHoliday = useCallback(
    async (departmentId: string, holidayId: string) => {
      try {
        setIsLoading(true);
        setError(null);
        await deleteHoliday(departmentId, holidayId);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to delete holiday');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const addAgent = useCallback(async (departmentId: string, data: AddAgent) => {
    try {
      setIsLoading(true);
      setError(null);
      await addDepartmentAgent(departmentId, data);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error('Failed to add agent');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reorderAgents = useCallback(
    async (departmentId: string, data: UpdateAgentOrder) => {
      try {
        setIsLoading(true);
        setError(null);
        await updateAgentOrder(departmentId, data);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to reorder agents');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const removeAgent = useCallback(
    async (departmentId: string, userId: string) => {
      try {
        setIsLoading(true);
        setError(null);
        await removeDepartmentAgent(departmentId, userId);
      } catch (err) {
        const error =
          err instanceof Error ? err : new Error('Failed to remove agent');
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const assignPhoneNumber = useCallback(
    async (departmentId: string, phoneNumberId: string, isPrimary: boolean) => {
      try {
        setIsLoading(true);
        setError(null);
        await assignDepartmentPhoneNumber(
          departmentId,
          phoneNumberId,
          isPrimary,
        );
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
    async (departmentId: string, phoneNumberId: string) => {
      try {
        setIsLoading(true);
        setError(null);
        await removeDepartmentPhoneNumber(departmentId, phoneNumberId);
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
    create,
    update,
    remove,
    restore,
    updateSettings,
    uploadGreeting,
    removeGreeting,
    setBusinessHours,
    createHoliday,
    editHoliday,
    removeHoliday,
    addAgent,
    reorderAgents,
    removeAgent,
    assignPhoneNumber,
    removePhoneNumber,
  };
}
