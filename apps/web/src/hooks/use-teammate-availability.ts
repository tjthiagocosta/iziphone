'use client';

import type { UserAvailability } from '@repo/dto';
import { useEffect, useState } from 'react';
import { fetchAvailability } from '@/lib/api/call-controller';
import { mergeTeammateAvailability } from '@/lib/telephony/availability';

/** How often an open transfer list asks again who can take a call. */
const POLL_MS = 10_000;

export interface TeammateAvailabilityOptions {
  userIds: readonly string[];
  /** Asked about only while something shows it, such as an open list. */
  enabled: boolean;
  getRealtimeToken: () => Promise<string>;
}

/**
 * Where each teammate stands, read when `enabled` turns on and every ten
 * seconds after. It starts empty every time, so that nothing from an earlier
 * look (or from before the controller's Redis restarted and its revisions
 * began again) outranks what the controller says now. A teammate missing
 * from the map is not known, which a failed read also leaves them as.
 */
export function useTeammateAvailability({
  userIds,
  enabled,
  getRealtimeToken,
}: TeammateAvailabilityOptions): ReadonlyMap<string, UserAvailability> {
  const [availability, setAvailability] = useState<
    ReadonlyMap<string, UserAvailability>
  >(() => new Map());
  // The ids as one value, so that a new array holding the same teammates
  // does not restart the polling.
  const idList = userIds.join(',');

  useEffect(() => {
    setAvailability(new Map());
    if (!enabled || idList === '') {
      return;
    }

    let isCurrent = true;
    // One token serves every read while the list is open, which is minutes
    // at most against the token's hour; a failed read drops it, in case it
    // was the token that failed.
    let token: Promise<string> | null = null;
    const ids = idList.split(',');
    const read = () => {
      token ??= getRealtimeToken();
      token
        .then((realtimeToken) => fetchAvailability(realtimeToken, ids))
        .then(
          (users) => {
            if (isCurrent) {
              setAvailability((current) =>
                mergeTeammateAvailability(current, users),
              );
            }
          },
          (error: unknown) => {
            // The controller refuses a transfer to someone who cannot take
            // it, so an unknown teammate stays pickable rather than wrongly
            // shown as away.
            console.error('Failed to read teammates availability', error);
            token = null;
            if (isCurrent) {
              setAvailability(new Map());
            }
          },
        );
    };

    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      isCurrent = false;
      window.clearInterval(timer);
    };
  }, [enabled, idList, getRealtimeToken]);

  return availability;
}
