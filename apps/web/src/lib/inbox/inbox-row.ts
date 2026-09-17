import { callCounterparty, callLine } from '@repo/dto';
import { formatDuration } from '../duration';
import { lineName } from '../line';
import { formatPhoneNumber } from '../phone-number';
import { type InboxItem, isMissedCall } from './inbox-item';

/** Everything a row shows, decided away from the component that renders it. */
export interface InboxRow {
  key: string;
  /** Who the row is about: the contact's name, or their number. */
  title: string;
  /** The name alone, for initials; null when the directory has none. */
  name: string | null;
  /** Stable across a rename, so an avatar colour does not move with a name. */
  identity: string;
  /** The initials to show for an unnamed contact: the end of their number. */
  fallback: string;
  /**
   * Which of our numbers the row is on. One contact has a separate row per
   * line, so without this two rows read as the same conversation twice.
   */
  line: string;
  preview: string;
  /** What the row is, for the icon beside its preview. */
  icon: 'message' | 'call' | 'missed' | 'voicemail';
  isMissed: boolean;
  unreadCount: number;
  sortKey: number;
  /**
   * The thread to open. A call has none: a contact has one conversation per
   * line, and matching on the number alone would open somebody else's.
   */
  href: string | null;
  /**
   * For a row with no thread to open: the number to dial and our number the
   * call was on, which the call back prefers so the other party sees the
   * number they know. `line` is not a number on the record of a call placed
   * before calls had a line.
   */
  callBack: { number: string; line: string } | null;
}

export function inboxRow(item: InboxItem): InboxRow {
  if (item.kind === 'call') {
    const { call } = item;
    const counterparty = callCounterparty(call);

    return {
      key: item.key,
      title: call.contact?.name ?? formatPhoneNumber(counterparty),
      name: call.contact?.name ?? null,
      identity: call.contact?.id ?? counterparty,
      fallback: counterparty.slice(-2),
      line: lineName({
        phoneNumber: callLine(call),
        // A number we have since released is not in the directory at all, and
        // one that is may have been left unlabelled; the department that
        // answered on it names the line either way.
        label: call.line?.label ?? null,
        ownerName: call.department?.name ?? null,
      }),
      preview: callPreview(call),
      icon: call.hasVoicemail
        ? 'voicemail'
        : isMissedCall(call)
          ? 'missed'
          : 'call',
      isMissed: isMissedCall(call),
      unreadCount: 0,
      sortKey: item.sortKey,
      href: null,
      callBack: { number: counterparty, line: callLine(call) },
    };
  }

  const { conversation } = item;
  const { contact, sourcePhoneNumber } = conversation;

  return {
    key: item.key,
    title: contact.name ?? formatPhoneNumber(contact.phoneNumber),
    name: contact.name,
    identity: contact.id,
    fallback: contact.phoneNumber.slice(-2),
    line: lineName(sourcePhoneNumber),
    preview:
      conversation.lastMessageDirection === 'OUTBOUND'
        ? `You: ${conversation.lastMessagePreview ?? ''}`
        : (conversation.lastMessagePreview ?? ''),
    icon: 'message',
    isMissed: false,
    unreadCount: conversation.unreadCount,
    sortKey: item.sortKey,
    href: `/app/conversations/${conversation.id}`,
    callBack: null,
  };
}

function callPreview(call: {
  direction: string;
  status: string;
  duration: number | null;
  hasVoicemail: boolean;
}): string {
  if (call.hasVoicemail) {
    return call.duration
      ? `Voicemail · ${formatDuration(call.duration)}`
      : 'Voicemail';
  }

  if (isMissedCall(call)) {
    return 'Missed call';
  }

  const heading = call.direction === 'inbound' ? 'Inbound' : 'Outbound';
  return call.duration
    ? `${heading} · ${formatDuration(call.duration)}`
    : heading;
}
