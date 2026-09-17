'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCallLines } from '@/lib/api/user';
import {
  type CallLines,
  type CallLinesAnswer,
  callLinesOf,
  nextCallLinesAnswer,
} from '@/lib/telephony/call-line';

export interface UseCallLinesReturn {
  callLines: CallLines;
  /**
   * Asks again: after a failure, and whenever the list is about to be chosen
   * from, because an administrator can change a membership while the tab is
   * open.
   */
  reload: () => void;
}

/**
 * The numbers the signed-in user may place calls from. Nothing is asked of
 * the API until the session names a user.
 */
export function useCallLines(session: {
  userId: string | undefined;
  isLoading: boolean;
}): UseCallLinesReturn {
  const { userId, isLoading } = session;
  const [answer, setAnswer] = useState<CallLinesAnswer | null>(null);
  // Only the latest request may answer: an older one that lands late would
  // put back a list that has since changed.
  const latestRequest = useRef(0);

  const reload = useCallback(() => {
    if (!userId) {
      return;
    }

    latestRequest.current += 1;
    const request = latestRequest.current;
    const settle = (lines: CallLinesAnswer['lines']) => {
      if (latestRequest.current === request) {
        setAnswer((previous) =>
          nextCallLinesAnswer(previous, { userId, lines }),
        );
      }
    };

    getCallLines().then(
      (result) => settle(result.lines),
      // Not dropped: it becomes the `failed` state, which the picker shows
      // with a retry. The cause adds nothing the user could act on.
      () => settle(null),
    );
  }, [userId]);

  useEffect(() => {
    reload();

    return () => {
      // An answer still on its way was for the previous user.
      latestRequest.current += 1;
    };
  }, [reload]);

  return { callLines: callLinesOf({ userId, isLoading }, answer), reload };
}
