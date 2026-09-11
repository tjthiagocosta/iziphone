'use client';

import type { MessageConversation } from '@repo/dto';
import { SMS_BODY_MAX_LENGTH } from '@repo/dto';
import { Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useMessageSenders } from '@/hooks/use-message-senders';
import { useSendSms } from '@/hooks/use-send-sms';
import { ApiError } from '@/lib/api/client';
import { lineName } from '@/lib/line';
import { sendEligibility } from '@/lib/messaging/send-eligibility';
import { sendFailureFrom } from '@/lib/messaging/send-failure';

interface MessageInputProps {
  conversation: MessageConversation;
  /** Re-reads the thread, so a stored failure shows up where it happened. */
  onSent: () => void;
}

/**
 * The composer for one thread. Its caller keys it on the conversation, so a
 * different thread arrives as a new composer: an unsent draft never follows
 * the reader to somebody else's conversation.
 */
export function MessageInput({ conversation, onSent }: MessageInputProps) {
  const { senders, isLoading: loadingSenders } = useMessageSenders();
  const { send, isSending } = useSendSms();
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  // One key per draft: a retry after a provider failure has to look like the
  // same message, or the contact gets two.
  const draftKey = useRef(crypto.randomUUID());

  const eligibility = sendEligibility(conversation, senders);
  const canSend = eligibility.canSend && !loadingSenders;

  const handleSend = async () => {
    if (!body.trim() || !canSend || isSending) {
      return;
    }

    try {
      await send({
        fromPhoneNumberId: conversation.sourcePhoneNumber.id,
        conversationId: conversation.id,
        body,
        idempotencyKey: draftKey.current,
      });

      setBody('');
      setFailure(null);
      draftKey.current = crypto.randomUUID();
      onSent();
    } catch (cause) {
      if (!(cause instanceof ApiError)) {
        setFailure(
          cause instanceof Error ? cause.message : 'The message was not sent',
        );
        return;
      }

      const outcome = sendFailureFrom(cause.status, cause.message);

      if (outcome.persisted) {
        // The API stored it as failed; the thread shows the text and why, so
        // leaving it in the box as well would read as two messages.
        setBody('');
        draftKey.current = crypto.randomUUID();
        onSent();
      }

      setFailure(outcome.message);
    }
  };

  return (
    <div className="border-t border-border bg-background p-4">
      {!eligibility.canSend && !loadingSenders && (
        <p className="mb-2 text-sm text-muted-foreground">
          {eligibility.reason}
        </p>
      )}

      {failure && <p className="mb-2 text-sm text-destructive">{failure}</p>}

      <div className="flex items-end gap-2">
        <div className="flex-1 bg-card rounded-lg border border-border">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              canSend
                ? `Message from ${lineName(conversation.sourcePhoneNumber)}`
                : 'You cannot reply here'
            }
            disabled={!canSend}
            maxLength={SMS_BODY_MAX_LENGTH}
            rows={1}
            className="w-full bg-transparent px-4 py-3 text-sm resize-none focus:outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed"
            style={{ minHeight: '44px', maxHeight: '120px' }}
          />
        </div>

        <Button
          onClick={() => void handleSend()}
          disabled={!body.trim() || !canSend || isSending}
          size="icon"
          className="h-11 w-11 rounded-full bg-info hover:bg-info/90 disabled:bg-muted disabled:text-muted-foreground"
        >
          <Send className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
