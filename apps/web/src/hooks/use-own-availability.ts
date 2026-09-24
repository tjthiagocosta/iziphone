'use client';

import type { UserAvailability } from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchOwnAvailability,
  requestDoNotDisturb,
} from '@/lib/api/call-controller';
import {
  applyOwnAnswer,
  applyOwnEvent,
  applyOwnSnapshot,
  type OwnAvailability,
} from '@/lib/telephony/availability';

export interface OwnAvailabilityOptions {
  /** Absent while signed out; nothing is known then. */
  userId: string | undefined;
  getRealtimeToken: () => Promise<string>;
}

export interface OwnAvailabilityState {
  /**
   * Whether the user's do not disturb is on. Null until the controller has
   * said, again after each reconnect, and while a read of it has failed.
   */
  doNotDisturb: boolean | null;
  isChangingDoNotDisturb: boolean;
  /** Why do not disturb could not be read, or the last switch failed. */
  doNotDisturbError: string | null;
  setDoNotDisturb: (on: boolean) => void;
  /** For each `user_availability` the socket delivers. */
  applyEvent: (event: UserAvailability) => void;
  /**
   * Forget what was known and read it afresh. The socket asks each time it
   * connects, because what was known may be from before a restart of the
   * controller's Redis, whose revisions start again from zero; the menu asks
   * when it opens on a do not disturb that could not be read.
   */
  resync: () => void;
}

/** The user's own do not disturb, as the controller keeps it. */
export function useOwnAvailability({
  userId,
  getRealtimeToken,
}: OwnAvailabilityOptions): OwnAvailabilityState {
  const [own, setOwn] = useState<OwnAvailability | null>(null);
  const [isChangingDoNotDisturb, setIsChangingDoNotDisturb] = useState(false);
  const [doNotDisturbError, setDoNotDisturbError] = useState<string | null>(
    null,
  );
  const getRealtimeTokenRef = useRef(getRealtimeToken);
  // Counts resyncs and applied answers, so that a snapshot asked for before
  // the latest of them is dropped even when its revision looks newer.
  const generationRef = useRef(0);

  useEffect(() => {
    getRealtimeTokenRef.current = getRealtimeToken;
  }, [getRealtimeToken]);

  // Whatever was known belongs to the user who has just signed out.
  useEffect(() => {
    if (!userId) {
      return;
    }
    return () => {
      generationRef.current += 1;
      setOwn(null);
      setDoNotDisturbError(null);
    };
  }, [userId]);

  const applyEvent = useCallback(
    (event: UserAvailability) => {
      if (event.userId === userId) {
        setOwn((current) => applyOwnEvent(current, event));
      }
    },
    [userId],
  );

  const resync = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setOwn(null);
    setDoNotDisturbError(null);

    getRealtimeTokenRef
      .current()
      .then(fetchOwnAvailability)
      .then(
        (snapshot) => {
          if (generation === generationRef.current) {
            setOwn((current) => applyOwnSnapshot(current, snapshot));
          }
        },
        (error: unknown) => {
          console.error('Failed to read own availability', error);
          if (generation === generationRef.current) {
            setDoNotDisturbError('Could not read whether do not disturb is on');
          }
        },
      );
  }, []);

  const setDoNotDisturb = useCallback((on: boolean) => {
    const generation = generationRef.current;
    setIsChangingDoNotDisturb(true);
    setDoNotDisturbError(null);

    getRealtimeTokenRef
      .current()
      .then((token) => requestDoNotDisturb(token, on))
      .then(
        (answer) => {
          if (generation === generationRef.current) {
            generationRef.current += 1;
            setOwn(applyOwnAnswer(answer));
          }
        },
        (error: unknown) => {
          setDoNotDisturbError(
            error instanceof Error
              ? error.message
              : 'Could not change do not disturb',
          );
        },
      )
      .finally(() => setIsChangingDoNotDisturb(false));
  }, []);

  return {
    doNotDisturb: own?.doNotDisturb ?? null,
    isChangingDoNotDisturb,
    doNotDisturbError,
    setDoNotDisturb,
    applyEvent,
    resync,
  };
}
