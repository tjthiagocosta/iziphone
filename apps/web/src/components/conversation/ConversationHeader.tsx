'use client';

import type { MessageConversation, OutboundCallLine } from '@repo/dto';
import { Phone } from 'lucide-react';
import { CallButton } from '@/components/call';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { avatarColorFor } from '@/lib/avatar-color';
import { initialsOf } from '@/lib/initials';
import { lineDescription } from '@/lib/line';
import { formatPhoneNumber } from '@/lib/phone-number';
import type { CallEligibility } from '@/lib/telephony/call-line';
import { cn } from '@/lib/utils';

interface ConversationHeaderProps {
  conversation: MessageConversation;
  /** Whether the reader may call from the line this thread is on. */
  callEligibility: CallEligibility;
  onCall: (line: OutboundCallLine) => void;
}

export function ConversationHeader({
  conversation,
  callEligibility,
  onCall,
}: ConversationHeaderProps) {
  const { contact, sourcePhoneNumber } = conversation;
  const name = contact.name ?? formatPhoneNumber(contact.phoneNumber);
  const line = lineDescription({
    ...sourcePhoneNumber,
    ownerName: conversation.owner?.name,
  });

  return (
    <div className="h-16 border-b border-border flex items-center px-4 gap-4 bg-background">
      <Avatar className="h-10 w-10">
        <AvatarFallback
          className={cn(avatarColorFor(contact.id), 'text-white')}
        >
          {initialsOf(contact.name, contact.phoneNumber.slice(-2))}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <p className="font-medium text-lg truncate">{name}</p>
        {/*
          Both parties, because the thread is a pair: the same contact on
          another of our numbers is a different thread with its own history.
        */}
        <p className="text-sm text-muted-foreground truncate">
          {formatPhoneNumber(contact.phoneNumber)} on {line}
        </p>
      </div>

      <CallButton
        variant="ghost"
        size="icon"
        className="h-9 w-9 text-muted-foreground hover:text-foreground"
        eligibility={callEligibility}
        label={`Call ${name}`}
        onCall={onCall}
        aria-label={`Call ${name}`}
      >
        <Phone className="h-5 w-5" />
      </CallButton>
    </div>
  );
}
