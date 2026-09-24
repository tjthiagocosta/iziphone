'use client';

import type { MessageConversationListItem, MessageSender } from '@repo/dto';
import { isDialablePhoneNumber, SMS_BODY_MAX_LENGTH } from '@repo/dto';
import { ChevronDown, Send, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMessageConversations } from '@/hooks/use-message-conversations';
import { useMessageSenders } from '@/hooks/use-message-senders';
import { useSendSms } from '@/hooks/use-send-sms';
import { ApiError } from '@/lib/api/client';
import { avatarColorFor } from '@/lib/avatar-color';
import { initialsOf } from '@/lib/initials';
import { lineDescription, lineName } from '@/lib/line';
import { sendFailureFrom } from '@/lib/messaging/send-failure';
import { formatPhoneNumber } from '@/lib/phone-number';
import { cn } from '@/lib/utils';

/** A destination is a contact already messaged, or a number typed in. */
interface Recipient {
  phoneNumber: string;
  name: string | null;
}

export function NewMessageView() {
  const router = useRouter();
  const { senders, isLoading: loadingSenders } = useMessageSenders();
  const { send, isSending } = useSendSms();

  const [senderId, setSenderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [body, setBody] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const draftKey = useRef(crypto.randomUUID());

  const sendable = senders.filter((sender) => sender.smsEnabled);
  const sender =
    sendable.find((option) => option.id === senderId) ?? sendable[0];

  /*
   * The search runs against conversations rather than a contact list: the API
   * already matches it on both the name and the digits of the number, and a
   * new message to somebody never messaged is served by typing the number.
   */
  const { conversations } = useMessageConversations({
    search: search.trim() || undefined,
    limit: 20,
    autoFetch: search.trim().length > 0,
  });

  /*
   * This screen addresses a number, so a thread with a short code or with a
   * service's name is not offered here: the number chosen above decides which
   * thread the message joins, and there is no number to start one with. Those
   * threads are answered where they are, from the inbox.
   */
  const addressable = conversations.filter((conversation) =>
    isDialablePhoneNumber(conversation.contact.phoneNumber),
  );

  const typedNumber = isDialablePhoneNumber(search.trim())
    ? search.trim()
    : null;

  const handleSend = async () => {
    if (!recipient || !sender || !body.trim() || isSending) {
      return;
    }

    try {
      const result = await send({
        fromPhoneNumberId: sender.id,
        to: recipient.phoneNumber,
        body,
        idempotencyKey: draftKey.current,
      });

      router.push(`/app/conversations/${result.conversationId}`);
    } catch (cause) {
      if (!(cause instanceof ApiError)) {
        setFailure(
          cause instanceof Error ? cause.message : 'The message was not sent',
        );
        return;
      }

      /*
       * A failed first message does create the conversation, but the error
       * body's conversation id does not survive the client's error mapping,
       * so there is nowhere to send the reader: the draft stays here with the
       * reason, and the inbox will show the thread on its next refresh.
       */
      const outcome = sendFailureFrom(cause.status, cause.message);

      if (outcome.persisted) {
        // The failed attempt is stored under this key, and the same key would
        // only be answered with it: sending the draft again is a new message.
        draftKey.current = crypto.randomUUID();
      }

      setFailure(outcome.message);
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="p-6 border-b border-border">
        <h1 className="text-xl font-semibold mb-4">New message</h1>

        <div className="flex items-center gap-4 mb-4">
          <span className="text-sm text-muted-foreground w-12">From:</span>
          {loadingSenders ? (
            <span className="text-sm text-muted-foreground">Loading…</span>
          ) : sender ? (
            <SenderPicker
              senders={sendable}
              selected={sender}
              onSelect={(option) => setSenderId(option.id)}
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              You have no number that can send text messages.
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground w-12">To:</span>
          {recipient ? (
            <div className="flex items-center gap-2 bg-secondary rounded-full px-3 py-1">
              <span className="text-sm">
                {recipient.name ?? formatPhoneNumber(recipient.phoneNumber)}
              </span>
              <button
                type="button"
                onClick={() => setRecipient(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Choose someone else"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Type a name or number"
              className="bg-transparent border-0 border-b border-border rounded-none focus-visible:ring-0 px-0"
            />
          )}
        </div>
      </div>

      {recipient ? (
        <div className="flex-1 flex flex-col">
          <div className="flex-1 flex items-center justify-center text-center text-muted-foreground">
            <div>
              <p className="text-lg font-medium">
                Message to{' '}
                {recipient.name ?? formatPhoneNumber(recipient.phoneNumber)}
              </p>
              {sender && <p className="text-sm">from {lineName(sender)}</p>}
            </div>
          </div>

          <div className="border-t border-border p-4">
            {failure && (
              <p className="mb-2 text-sm text-destructive">{failure}</p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="New message"
                maxLength={SMS_BODY_MAX_LENGTH}
                rows={1}
                className="flex-1 bg-card rounded-lg border border-border px-4 py-3 text-sm resize-none focus:outline-hidden placeholder:text-muted-foreground"
                style={{ minHeight: '44px', maxHeight: '120px' }}
              />
              <Button
                onClick={() => void handleSend()}
                disabled={!body.trim() || !sender || isSending}
                size="icon"
                className="h-11 w-11 rounded-full bg-info hover:bg-info/90 disabled:bg-muted disabled:text-muted-foreground"
              >
                <Send className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-2">
            {typedNumber && (
              <RecipientItem
                identity={typedNumber}
                name={null}
                phoneNumber={typedNumber}
                onClick={() =>
                  setRecipient({ phoneNumber: typedNumber, name: null })
                }
              />
            )}

            {addressable.map((conversation) => (
              <ConversationRecipient
                key={conversation.id}
                conversation={conversation}
                onClick={() =>
                  setRecipient({
                    phoneNumber: conversation.contact.phoneNumber,
                    name: conversation.contact.name,
                  })
                }
              />
            ))}

            {search.trim() && !typedNumber && addressable.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                Nobody found. Type a full phone number to start a conversation.
              </p>
            )}

            {!search.trim() && (
              <p className="text-sm text-muted-foreground text-center py-8">
                Enter a name or number to start a conversation.
              </p>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

interface SenderPickerProps {
  senders: readonly MessageSender[];
  selected: MessageSender;
  onSelect: (sender: MessageSender) => void;
}

function SenderPicker({ senders, selected, onSelect }: SenderPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto p-0 hover:bg-transparent justify-start gap-2 text-base"
        >
          {lineDescription(selected)}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {senders.map((sender) => (
          <DropdownMenuItem key={sender.id} onClick={() => onSelect(sender)}>
            {lineDescription(sender)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ConversationRecipient({
  conversation,
  onClick,
}: {
  conversation: MessageConversationListItem;
  onClick: () => void;
}) {
  return (
    <RecipientItem
      identity={conversation.contact.id}
      name={conversation.contact.name}
      phoneNumber={conversation.contact.phoneNumber}
      onClick={onClick}
    />
  );
}

interface RecipientItemProps {
  identity: string;
  name: string | null;
  phoneNumber: string;
  onClick: () => void;
}

function RecipientItem({
  identity,
  name,
  phoneNumber,
  onClick,
}: RecipientItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-secondary transition-colors text-left"
    >
      <Avatar className="h-10 w-10">
        <AvatarFallback className={cn(avatarColorFor(identity), 'text-white')}>
          {initialsOf(name, phoneNumber.slice(-2))}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <span className="font-medium truncate">
          {name ?? formatPhoneNumber(phoneNumber)}
        </span>
        {name && (
          <p className="text-sm text-muted-foreground truncate">
            {formatPhoneNumber(phoneNumber)}
          </p>
        )}
      </div>
    </button>
  );
}
