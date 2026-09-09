'use client';

import { useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { MockContact, MockInteraction } from '@/lib/mock-data';
import { ConversationHeader } from './ConversationHeader';
import { InteractionCard } from './InteractionCard';
import { MessageInput } from './MessageInput';

interface ConversationViewProps {
  contact: MockContact;
  interactions: MockInteraction[];
}

// Group interactions by date
function groupInteractionsByDate(interactions: MockInteraction[]) {
  const groups: { date: string; interactions: MockInteraction[] }[] = [];

  // Sort by timestamp descending (newest first for display, but we'll reverse for each group)
  const sorted = [...interactions].sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  );

  sorted.forEach((interaction) => {
    // For grouping, we want to use day-based labels
    const dayLabel = getDayLabel(interaction.timestamp);

    const existingGroup = groups.find((g) => g.date === dayLabel);
    if (existingGroup) {
      existingGroup.interactions.push(interaction);
    } else {
      groups.push({ date: dayLabel, interactions: [interaction] });
    }
  });

  // Reverse interactions within each group so oldest is first (top to bottom)
  groups.forEach((group) => {
    group.interactions.reverse();
  });

  // Reverse groups so oldest day is first
  groups.reverse();

  return groups;
}

function getDayLabel(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const inputDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );

  if (inputDate.getTime() === today.getTime()) {
    return 'Today';
  }
  if (inputDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  // Check if it's within this week
  const daysDiff = Math.floor(
    (today.getTime() - inputDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (daysDiff < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  // Otherwise show full date
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export function ConversationView({
  contact,
  interactions,
}: ConversationViewProps) {
  const groupedInteractions = useMemo(
    () => groupInteractionsByDate(interactions),
    [interactions],
  );

  const handleSendMessage = (message: string) => {
    console.log('Sending message:', message);
    // TODO: Integrate with API
  };

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-background">
        {/* Header */}
        <ConversationHeader contact={contact} />

        {/* Messages/Interactions */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6">
            {groupedInteractions.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="flex justify-center mb-4">
                  <span className="px-3 py-1 text-xs text-muted-foreground bg-secondary rounded-full">
                    {group.date}
                  </span>
                </div>

                {/* Interactions for this date */}
                <div className="space-y-4">
                  {group.interactions.map((interaction) => (
                    <InteractionCard
                      key={interaction.id}
                      interaction={interaction}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* Message Input */}
        <MessageInput onSend={handleSendMessage} />
      </div>
    </TooltipProvider>
  );
}
