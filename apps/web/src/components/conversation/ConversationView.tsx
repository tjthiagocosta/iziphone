'use client';

import { useCall } from '@/components/providers/CallProvider';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useConversationThread } from '@/hooks/use-conversation-thread';
import { ConversationHeader } from './ConversationHeader';
import { InteractionCard } from './InteractionCard';
import { MessageInput } from './MessageInput';

interface ConversationViewProps {
  conversationId: string;
}

export function ConversationView({ conversationId }: ConversationViewProps) {
  const { makeCall } = useCall();
  const { conversation, days, isLoading, error, hasMore, loadOlder, refetch } =
    useConversationThread(conversationId);

  if (isLoading && !conversation) {
    return <Notice>Loading…</Notice>;
  }

  if (!conversation) {
    return (
      <Notice>{error?.message ?? 'This conversation was not found'}</Notice>
    );
  }

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-background">
        <ConversationHeader
          conversation={conversation}
          onCall={() => void makeCall(conversation.contact.phoneNumber)}
        />

        <ScrollArea className="flex-1">
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
        </ScrollArea>

        {/* Keyed: a draft belongs to the thread it was typed in. */}
        <MessageInput
          key={conversation.id}
          conversation={conversation}
          onSent={refetch}
        />
      </div>
    </TooltipProvider>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center">
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
