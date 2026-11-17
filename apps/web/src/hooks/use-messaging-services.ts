'use client';

import type { MessagingServicesResponse } from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getMessagingServices,
  updateDefaultMessagingService,
} from '@/lib/api/admin';

/**
 * The account's messaging services with their campaigns, and the default new
 * numbers join, read from Twilio while `enabled` (a picker is open, or the
 * settings page is shown).
 */
export function useMessagingServices(enabled: boolean) {
  const [data, setData] = useState<MessagingServicesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  // A read answered after the picker closed, or after a newer read, must not land.
  const latest = useRef(0);

  const fetchServices = useCallback(async () => {
    const request = ++latest.current;

    try {
      setIsLoading(true);
      setError(null);
      const services = await getMessagingServices();
      if (request === latest.current) {
        setData(services);
      }
    } catch (err) {
      if (request !== latest.current) return;

      setData(null);
      setError(
        err instanceof Error
          ? err
          : new Error('Failed to read the messaging services'),
      );
    } finally {
      if (request === latest.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void fetchServices();
      return;
    }

    latest.current++;
    setData(null);
    setError(null);
    setSaveError(null);
    setIsLoading(false);
  }, [enabled, fetchServices]);

  /**
   * Stores the default and keeps what the API answered; false when it
   * refused, with the reason in `saveError`, which leaves the list readable.
   */
  const saveDefault = useCallback(
    async (messagingServiceSid: string | null) => {
      setIsSaving(true);
      setSaveError(null);

      try {
        const { defaultSid } = await updateDefaultMessagingService({
          messagingServiceSid,
        });
        setData((previous) => (previous ? { ...previous, defaultSid } : null));
        return true;
      } catch (err) {
        setSaveError(
          err instanceof Error
            ? err
            : new Error('Failed to save the default messaging service'),
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [],
  );

  return {
    data,
    isLoading,
    isSaving,
    error,
    saveError,
    saveDefault,
    refetch: fetchServices,
  };
}
