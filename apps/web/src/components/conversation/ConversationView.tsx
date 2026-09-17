'use client';

import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { useCall } from '@/components/providers/CallProvider';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConversationThread } from '@/hooks/use-conversation-thread';
import { callFromConversationLine } from '@/lib/telephony/call-line';
import { ConversationHeader } from './ConversationHeader';
import { InteractionCard } from './InteractionCard';
import { MessageInput } from './MessageInput';

interface ConversationViewProps {
  conversationId: string;
}

export function ConversationView({ conversationId }: ConversationViewProps) {
  const { makeCall, callLines } = useCall();
  const {
    conversation,
    days,
    isLoading,
    error,
    hasMore,
    restarts,
    loadOlder,
    refetch,
  } = useConversationThread(conversationId);
  const scrollRef = useRef<ThreadScrollHandle>(null);

  if (isLoading && !conversation) {
    return <Notice>Loading…</Notice>;
  }

  if (!conversation) {
    return (
      <Notice>{error?.message ?? 'This conversation was not found'}</Notice>
    );
  }

  const newestDay = days[days.length - 1];
  const newestEntry = newestDay?.entries[newestDay.entries.length - 1];

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-background">
        <ConversationHeader
          conversation={conversation}
          callEligibility={callFromConversationLine(
            callLines,
            conversation.sourcePhoneNumber.phoneNumber,
          )}
          onCall={(line) =>
            void makeCall(conversation.contact.phoneNumber, line.phoneNumber)
          }
        />

        {/*
          Keyed: where the reader is belongs to the thread they are in, and to
          the messages it had. One that started over opens like a new one.
        */}
        <ThreadScroll
          key={`${conversation.id}:${restarts}`}
          ref={scrollRef}
          newestKey={newestEntry?.key}
        >
          <div className="p-4 space-y-6">
            {hasMore && (
              <div className="flex justify-center">
                <Button variant="ghost" size="sm" onClick={loadOlder}>
                  Show older
                </Button>
              </div>
            )}

            {error && (
              <p className="text-center text-sm text-destructive">
                {error.message}
              </p>
            )}

            {days.map((day) => (
              <div key={day.key}>
                <div className="flex justify-center mb-4">
                  <span className="px-3 py-1 text-xs text-muted-foreground bg-secondary rounded-full">
                    {day.label}
                  </span>
                </div>

                <div className="space-y-4">
                  {day.entries.map((entry) => (
                    <InteractionCard
                      key={entry.key}
                      entry={entry}
                      conversation={conversation}
                    />
                  ))}
                </div>
              </div>
            ))}

            {days.length === 0 && !error && (
              <p className="text-center text-sm text-muted-foreground">
                Nothing here yet.
              </p>
            )}
          </div>
        </ThreadScroll>

        {/* Keyed: a draft belongs to the thread it was typed in. */}
        <MessageInput
          key={conversation.id}
          conversation={conversation}
          onSent={() => {
            // Sending is asking to see the message, wherever the reader was.
            scrollRef.current?.showNewest();
            refetch();
          }}
        />
      </div>
    </TooltipProvider>
  );
}

interface ThreadScrollHandle {
  /** Goes to the newest entry and stays with it, wherever the reader was. */
  showNewest(): void;
}

/**
 * The scrolling part of a thread. It opens at the newest entry and follows a
 * new one only while the reader is already down there; one that arrives while
 * they read further up does not move them. Where the reader ends up after an
 * older page is put in front is not handled here.
 */
function ThreadScroll({
  ref,
  newestKey,
  children,
}: {
  ref: Ref<ThreadScrollHandle>;
  newestKey: string | undefined;
  children: React.ReactNode;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // True from the start, which is what opens the thread at its newest entry.
  const atEndRef = useRef(true);

  useImperativeHandle(
    ref,
    () => ({
      showNewest() {
        // Set here as well: the entry can arrive before the observer reports
        // the scroll, and it has to be followed.
        atEndRef.current = true;
        endRef.current?.scrollIntoView({ block: 'end' });
      },
    }),
    [],
  );

  useEffect(() => {
    const end = endRef.current;
    if (!end) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) {
        atEndRef.current = latest.isIntersecting;
      }
    });
    observer.observe(end);
    return () => observer.disconnect();
  }, []);

  // A layout effect, so the new entry is never painted below the fold first.
  // It runs before the observer hears about the taller thread, so what it
  // reads is where the reader was before the entry came.
  useLayoutEffect(() => {
    if (newestKey && atEndRef.current) {
      endRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [newestKey]);

  return (
    <ScrollArea className="flex-1">
      {children}
      {/*
        Covers the last stretch of the thread without adding to its height,
        so being near the end counts as being there.
      */}
      <div
        ref={endRef}
        aria-hidden
        className="-mt-12 h-12 pointer-events-none"
      />
    </ScrollArea>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center">
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
