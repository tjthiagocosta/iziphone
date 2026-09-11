'use client';

import type { MessageConversation } from '@repo/dto';
import { callCounterparty } from '@repo/dto';
import {
  AlertCircle,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Voicemail,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { avatarColorFor } from '@/lib/avatar-color';
import type { TimelineEntry } from '@/lib/conversation/timeline';
import { formatDuration } from '@/lib/duration';
import { isMissedCall } from '@/lib/inbox/inbox-item';
import { initialsOf } from '@/lib/initials';
import { lineName } from '@/lib/line';
import { formatPhoneNumber } from '@/lib/phone-number';
import { cn } from '@/lib/utils';

interface InteractionCardProps {
  entry: TimelineEntry;
  conversation: MessageConversation;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function InteractionCard({ entry, conversation }: InteractionCardProps) {
  const { contact, sourcePhoneNumber } = conversation;
  const contactName = contact.name ?? formatPhoneNumber(contact.phoneNumber);

  /*
   * An outbound entry is attributed to the line, not to a person: `Message`
   * records no sender, and on a shared department line the colleague who
   * replied is not necessarily the one reading it now.
   */
  const line = lineName({
    ...sourcePhoneNumber,
    ownerName: conversation.owner?.name,
  });

  if (entry.kind === 'message') {
    const { message } = entry;
    const outbound = message.direction === 'OUTBOUND';

    return (
      <Party
        name={outbound ? line : contactName}
        identity={outbound ? sourcePhoneNumber.id : contact.id}
        fallback={
          outbound
            ? sourcePhoneNumber.phoneNumber.slice(-2)
            : contact.phoneNumber.slice(-2)
        }
        at={entry.at}
      >
        <div
          className={cn(
            'mt-1 rounded-lg p-3 max-w-md',
            message.status === 'FAILED'
              ? 'bg-destructive/10 border border-destructive/30'
              : 'bg-card',
          )}
        >
          {message.body && <p className="text-sm">{message.body}</p>}

          {message.attachments.map((attachment) => (
            <p key={attachment.id} className="text-xs text-muted-foreground">
              {attachment.fileName ?? attachment.mimeType}
            </p>
          ))}

          {message.status === 'FAILED' && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {message.failureReason ?? 'This message was not delivered'}
            </p>
          )}
        </div>
      </Party>
    );
  }

  const { call } = entry;
  const missed = isMissedCall(call);
  const inbound = call.direction === 'inbound';
  const CallIcon = call.hasVoicemail
    ? Voicemail
    : missed
      ? PhoneMissed
      : inbound
        ? PhoneIncoming
        : PhoneOutgoing;

  const title = call.hasVoicemail
    ? `${contactName} left a voicemail`
    : missed
      ? `Missed call from ${contactName}`
      : inbound
        ? `${contactName} called ${line}`
        : `${line} called ${contactName}`;

  return (
    <Party
      name={inbound ? contactName : line}
      identity={inbound ? contact.id : sourcePhoneNumber.id}
      fallback={
        inbound
          ? contact.phoneNumber.slice(-2)
          : sourcePhoneNumber.phoneNumber.slice(-2)
      }
      at={entry.at}
    >
      <div className="mt-1 bg-card rounded-lg p-3 max-w-lg">
        <div className="flex items-start gap-2">
          <CallIcon
            className={cn(
              'h-4 w-4 mt-0.5 shrink-0',
              missed ? 'text-destructive' : 'text-muted-foreground',
            )}
          />
          <div className="flex-1">
            <p
              className={cn(
                'font-medium text-sm',
                missed && 'text-destructive',
              )}
            >
              {title}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatPhoneNumber(callCounterparty(call))} →{' '}
              {formatPhoneNumber(inbound ? call.to : call.from)}
            </p>
            {call.duration !== null && !missed && (
              <p className="text-xs text-muted-foreground mt-1">
                Lasted {formatDuration(call.duration)}
              </p>
            )}
          </div>
        </div>

        {call.transcript && (
          <div className="mt-3 pt-3 border-t border-border">
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Transcript
            </p>
            <p className="text-sm text-muted-foreground">{call.transcript}</p>
          </div>
        )}
      </div>
    </Party>
  );
}

interface PartyProps {
  name: string;
  identity: string;
  fallback: string;
  at: number;
  children: React.ReactNode;
}

/** The avatar, name and time every entry carries, whoever it came from. */
function Party({ name, identity, fallback, at, children }: PartyProps) {
  return (
    <div className="flex gap-3">
      <Avatar className="h-8 w-8 mt-1">
        <AvatarFallback
          className={cn(avatarColorFor(identity), 'text-white text-sm')}
        >
          {initialsOf(name, fallback)}
        </AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{name}</span>
          <span className="text-xs text-muted-foreground">{timeOf(at)}</span>
        </div>
        {children}
      </div>
    </div>
  );
}
