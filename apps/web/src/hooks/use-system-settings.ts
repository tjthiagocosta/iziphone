'use client';

import type {
  SystemSettingsResponse,
  UpdateRecordingRetention,
} from '@repo/dto';
import { useCallback, useEffect, useState } from 'react';
import { getSystemSettings, updateRecordingRetention } from '@/lib/api/admin';

/** The deployment's settings, as the admin console reads and writes them. */
export function useSystemSettings() {
  const [settings, setSettings] = useState<SystemSettingsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      setSettings(await getSystemSettings());
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('Failed to load the settings'),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  /** Saves both retention policies and keeps what the API answered. */
  const saveRecordingRetention = useCallback(
    async (retention: UpdateRecordingRetention) => {
      setIsSaving(true);
      setError(null);

      try {
        setSettings(await updateRecordingRetention(retention));
        return true;
      } catch (err) {
        setError(
          err instanceof Error
            ? err
            : new Error('Failed to save the retention policy'),
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [],
  );

  return {
    settings,
    isLoading,
    isSaving,
    error,
    saveRecordingRetention,
    refetch: fetchSettings,
  };
}
