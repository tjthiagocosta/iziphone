'use client';

import type { Teammate } from '@repo/dto';
import { useCallback, useEffect, useState } from 'react';
import { getTeammates } from '@/lib/api/user';

interface UseTeammatesOptions {
  /** Absent while signed out; nothing is fetched then. */
  userId: string | undefined;
}

interface UseTeammatesReturn {
  teammates: Teammate[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** The people the signed-in user can hand a call to. */
export function useTeammates({
  userId,
}: UseTeammatesOptions): UseTeammatesReturn {
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [isLoading, setIsLoading] = useState(Boolean(userId));
  const [error, setError] = useState<Error | null>(null);

  const fetchTeammates = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const result = await getTeammates();
      setTeammates(result.teammates);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to fetch teammates'),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) {
      setTeammates([]);
      return;
    }
    fetchTeammates();
  }, [userId, fetchTeammates]);

  return { teammates, isLoading, error, refetch: fetchTeammates };
}
