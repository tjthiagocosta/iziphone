'use client';

import type { Contact, ContactConversation } from '@repo/dto';
import { Phone, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CallButton, CallLinePicker } from '@/components/call';
import { useCall } from '@/components/providers/CallProvider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useContacts } from '@/hooks/use-contacts';
import { avatarColorFor } from '@/lib/avatar-color';
import { initialsOf } from '@/lib/initials';
import { threadLineName } from '@/lib/line';
import { formatPhoneNumber } from '@/lib/phone-number';
import {
  type CallEligibility,
  callFromChosenLine,
  callToContact,
} from '@/lib/telephony/call-line';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 250;

/*
 * Read-only. A contact is created by messaging or calling somebody, holds only
 * a name and a number, and the API has no endpoint to write either.
 */
export function ContactsView() {
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');

  // Every keystroke would otherwise be a request, and the list is searched
  // server-side because it is paged there.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [typed]);

  const { contacts, total, isLoading, error } = useContacts({
    search: search || undefined,
  });

  // A contact can have a thread on several lines, so the list does not guess
  // one: calls from here leave from the line chosen above the list.
  const { callLines, chosenCallLineId } = useCall();
  const eligibility = callFromChosenLine(callLines, chosenCallLineId);

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold">Contacts</h1>
          {total > 0 && (
            <span className="text-sm text-muted-foreground">
              {total} {total === 1 ? 'contact' : 'contacts'}
            </span>
          )}
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Search by name or number"
            className="pl-9 bg-secondary border-0"
          />
        </div>

        <CallLinePicker className="mt-3" />
      </div>

      <ScrollArea className="flex-1">
        <div className="divide-y divide-border">
          {contacts.map((contact) => (
            <ContactItem
              key={contact.id}
              contact={contact}
              eligibility={eligibility}
            />
          ))}

          {contacts.length === 0 && (
            <div className="flex items-center justify-center h-64 px-6 text-center">
              <p className="text-muted-foreground">
                {error
                  ? error.message
                  : isLoading
                    ? 'Loading…'
                    : search
                      ? 'Nobody matches that.'
                      : 'People you message or call appear here.'}
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ContactItem({
  contact,
  eligibility,
}: {
  contact: Contact;
  eligibility: CallEligibility;
}) {
  const { makeCall } = useCall();
  const name = contact.name ?? formatPhoneNumber(contact.phoneNumber);

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <Avatar className="h-10 w-10">
        <AvatarFallback
          className={cn(avatarColorFor(contact.id), 'text-white')}
        >
          {initialsOf(contact.name, contact.phoneNumber.slice(-2))}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <span className="font-medium truncate">
          {contact.name ?? formatPhoneNumber(contact.phoneNumber)}
        </span>
        {contact.name && (
          <p className="text-sm text-muted-foreground">
            {formatPhoneNumber(contact.phoneNumber)}
          </p>
        )}

        {/*
         * One thread per line and owner of that line, so the threads are the
         * links: opening "the" conversation would mean picking one of them
         * for the reader.
         */}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {contact.conversations.map((conversation) => (
            <ConversationChip
              key={conversation.id}
              conversation={conversation}
              label={threadLineName(conversation, contact.conversations)}
            />
          ))}
        </div>
      </div>

      <CallButton
        variant="ghost"
        size="icon"
        className="h-9 w-9 shrink-0"
        eligibility={callToContact(eligibility, contact.phoneNumber)}
        label={`Call ${name}`}
        onCall={(line) => void makeCall(contact.phoneNumber, line.phoneNumber)}
        aria-label={`Call ${name}`}
      >
        <Phone className="h-4 w-4" />
      </CallButton>
    </div>
  );
}

function ConversationChip({
  conversation,
  label,
}: {
  conversation: ContactConversation;
  label: string;
}) {
  return (
    <Link
      href={`/app/conversations/${conversation.id}`}
      className="flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {label}
      {conversation.unreadCount > 0 && (
        <Badge className="h-4 min-w-4 justify-center px-1 text-[10px] bg-info text-white">
          {conversation.unreadCount}
        </Badge>
      )}
    </Link>
  );
}
