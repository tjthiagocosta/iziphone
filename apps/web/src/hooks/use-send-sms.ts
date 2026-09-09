'use client';

import type { SendSmsResponse } from '@repo/dto';
import { useCallback, useState } from 'react';
import { ApiError, sendSms } from '@/lib/api/user';

interface SendSmsInput {
  fromPhoneNumberId: string;
  conversationId?: string;
  to?: string;
  body: string;
}

interface UseSendSmsReturn {
  send: (input: SendSmsInput) => Promise<SendSmsResponse>;
  isSending: boolean;
  error: ApiError | Error | null;
  clearError: () => void;
}

export function useSendSms(): UseSendSmsReturn {
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const send = useCallback(async (input: SendSmsInput) => {
    try {
      setIsSending(true);
      setError(null);

      const result = await sendSms({
        ...input,
        idempotencyKey: crypto.randomUUID(),
      });

      return result;
    } catch (err) {
      const sendError =
        err instanceof ApiError
          ? err
          : err instanceof Error
            ? err
            : new Error('Failed to send message');
      setError(sendError);
      throw sendError;
    } finally {
      setIsSending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { send, isSending, error, clearError };
}
