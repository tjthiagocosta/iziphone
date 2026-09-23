import {
  canReceiveMessages,
  type MessageConversation,
  type MessageSender,
} from '@repo/dto';

/** Whether a reply can leave this thread, and what to say when it cannot. */
export type SendEligibility =
  | { canSend: true }
  | { canSend: false; reason: string };

type Thread = Pick<
  MessageConversation,
  'contact' | 'isSuppressed' | 'owner' | 'sourcePhoneNumber'
>;

/**
 * Decided before the composer is enabled rather than after the text is typed.
 *
 * A thread can be readable and still not writable: an agent sees a
 * department's conversations but may only send from the numbers they are a
 * sender for, and the API refuses that with `sender_mismatch` only once the
 * message is submitted. A reply always leaves from the thread's own line, so
 * that line is the one to check.
 */
export function sendEligibility(
  conversation: Thread,
  senders: readonly MessageSender[],
): SendEligibility {
  const { sourcePhoneNumber } = conversation;

  // Some senders are one way: a service texting from a name rather than a
  // number leaves nothing to route an answer to, whoever is looking at it.
  if (!canReceiveMessages(conversation.contact.phoneNumber)) {
    return {
      canSend: false,
      reason: 'This sender cannot receive replies.',
    };
  }

  if (conversation.isSuppressed) {
    return {
      canSend: false,
      reason: 'This contact has opted out of messages from this number.',
    };
  }

  const sender = senders.find((option) => option.id === sourcePhoneNumber.id);

  if (!sender) {
    return {
      canSend: false,
      reason: 'You cannot send from the number this conversation is on.',
    };
  }

  // A line that changed hands leaves its old threads with their old owner.
  // Somebody who can read one and still sends on the line, a member of both
  // departments, writes to the contact from the new owner's thread instead.
  if (
    conversation.owner?.type !== sender.ownerType ||
    conversation.owner.id !== sender.ownerId
  ) {
    return {
      canSend: false,
      reason:
        'This number has changed hands since this conversation. Start a new message to write from it.',
    };
  }

  if (!sender.smsEnabled) {
    return {
      canSend: false,
      reason: 'This number cannot send text messages.',
    };
  }

  return { canSend: true };
}
