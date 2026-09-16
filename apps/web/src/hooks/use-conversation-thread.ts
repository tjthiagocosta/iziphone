'use client';

import type { CallRecord, MessageConversation } from '@repo/dto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { listCalls } from '@/lib/api/calls';
import {
  buildTimeline,
  type TimelineDay,
  timelineFloor,
} from '@/lib/conversation/timeline';
import { useMessageThread } from './use-message-thread';

const CALL_PAGE_SIZE = 50;

/** See `useInbox`: the history row is written by a separate consumer. */
const CALL_HISTORY_DELAY_MS = 1000;

interface CallHistory {
  calls: CallRecord[];
  offset: number;
  exhausted: boolean;
}

const NO_CALLS: CallHistory = { calls: [], offset: 0, exhausted: false };

export interface UseConversationThreadReturn {
  conversation: MessageConversation | null;
  days: TimelineDay[];
  isLoading: boolean;
  error: Error | null;
  hasMore: boolean;
  /** Goes up when the messages start over from their newest page. */
  restarts: number;
  loadOlder: () => void;
  refetch: () => void;
}

/**
 * A thread as the screen shows it: the messages on this line and the calls
 * with the same contact on the same line, in one order.
 *
 * The calls are found by the pair of numbers, which is what makes the thread
 * a line's and not the contact's: the same contact reached on another
 * department's number is a different thread, and its calls stay there.
 */
export function useConversationThread(
  conversationId: string,
): UseConversationThreadReturn {
  const { lastEndedCall } = useCall();
  const thread = useMessageThread(conversationId);
  const [history, setHistory] = useState<CallHistory>(NO_CALLS);
  const [callError, setCallError] = useState<Error | null>(null);

  const historyRef = useRef(history);
  historyRef.current = history;
  const requestRef = useRef(0);

  const { conversation } = thread;
  const linePhone = conversation?.sourcePhoneNumber.phoneNumber;
  const contactPhone = conversation?.contact.phoneNumber;

  const loadCalls = useCallback(
    async (from: 'start' | 'next') => {
      if (!linePhone || !contactPhone) {
        return;
      }

      const request = ++requestRef.current;
      const offset = from === 'start' ? 0 : historyRef.current.offset;

      try {
        const page = await listCalls({
          linePhone,
          contactPhone,
          limit: CALL_PAGE_SIZE,
          offset,
        });

        if (request !== requestRef.current) {
          return;
        }

        setHistory((current) => {
          const byId = new Map(current.calls.map((call) => [call.id, call]));
          for (const call of page.calls) {
            byId.set(call.id, call);
          }
          const reached = Math.max(current.offset, offset + page.calls.length);

          return {
            calls: [...byId.values()],
            offset: reached,
            exhausted: page.calls.length < page.limit || reached >= page.total,
          };
        });
        setCallError(null);
      } catch (cause) {
        if (request === requestRef.current) {
          setCallError(
            cause instanceof Error
              ? cause
              : new Error('The call history failed to load'),
          );
        }
      }
    },
    [linePhone, contactPhone],
  );

  // A different thread has a different pair of numbers; start its calls empty
  // rather than showing the previous thread's while the first page arrives.
  useEffect(() => {
    setHistory(NO_CALLS);
    void loadCalls('start');
  }, [loadCalls]);

  useEffect(() => {
    if (!lastEndedCall) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadCalls('start');
    }, CALL_HISTORY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lastEndedCall, loadCalls]);

  const loadOlder = useCallback(() => {
    void thread.loadOlder();
    if (!historyRef.current.exhausted) {
      void loadCalls('next');
    }
  }, [thread.loadOlder, loadCalls]);

  const refetch = useCallback(() => {
    void thread.refresh();
    void loadCalls('start');
  }, [thread.refresh, loadCalls]);

  const oldestMessage = thread.messages[0];
  const oldestCall = history.calls[history.calls.length - 1];

  const days = buildTimeline(
    thread.messages,
    history.calls,
    undefined,
    timelineFloor(
      {
        oldest: oldestMessage ? Date.parse(oldestMessage.createdAt) : null,
        exhausted: !thread.hasMore,
      },
      {
        oldest: oldestCall ? Date.parse(oldestCall.createdAt) : null,
        exhausted: history.exhausted,
      },
    ),
  );

  return {
    conversation,
    days,
    isLoading: thread.isLoading,
    error: thread.error ?? callError,
    hasMore: thread.hasMore || !history.exhausted,
    restarts: thread.restarts,
    loadOlder,
    refetch,
  };
}
