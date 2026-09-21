import { type OutboundCallLine, toE164PhoneNumber } from '@repo/dto';

/*
 * Which of the user's numbers an outbound call leaves from. The other party
 * sees that number, and the call is kept on it, so every place that can start
 * a call decides the line before the button is enabled. The call controller
 * checks the same rule again when the call arrives; this is what the user is
 * told beforehand, not what keeps a call from leaving.
 */

/** The lines the user may call from, as far as the views know them yet. */
export type CallLines =
  | { status: 'loading' }
  /** No session in this tab: nothing was asked for, so nothing is on its way. */
  | { status: 'signed-out' }
  /** The request failed and no earlier one had answered; it can be retried. */
  | { status: 'failed' }
  | { status: 'loaded'; lines: readonly OutboundCallLine[] };

/** What a request for a user's lines came back with; no lines when it failed. */
export interface CallLinesAnswer {
  userId: string;
  lines: readonly OutboundCallLine[] | null;
}

/**
 * What the views are told about the lines, from what is known of the session
 * and of the request made for its user. The lines are asked for once the
 * session is known, so both waits are one "loading" to the reader. A session
 * that did not load leaves nothing on its way: calling that "loading" would
 * be a wait that never ends.
 */
export function callLinesOf(
  session: { userId: string | undefined; isLoading: boolean },
  answer: CallLinesAnswer | null,
): CallLines {
  if (!session.userId) {
    return { status: session.isLoading ? 'loading' : 'signed-out' };
  }

  // An answer that was for somebody else is not this user's lines.
  if (answer?.userId !== session.userId) {
    return { status: 'loading' };
  }

  return answer.lines
    ? { status: 'loaded', lines: answer.lines }
    : { status: 'failed' };
}

/**
 * The answer to keep once a request has settled. A refresh that fails does
 * not take away lines that did load for the same user: they were true a
 * moment ago, and the call controller has the last word on each call anyway.
 */
export function nextCallLinesAnswer(
  previous: CallLinesAnswer | null,
  settled: CallLinesAnswer,
): CallLinesAnswer {
  if (!settled.lines && previous?.lines && previous.userId === settled.userId) {
    return previous;
  }
  return settled;
}

/** A picked line, kept with who picked it. */
export interface CallLineChoice {
  userId: string;
  lineId: string;
}

/**
 * The choice that applies to whoever is signed in now. The next person to
 * sign in on the same tab starts from their own default, not from the line a
 * colleague picked, even when both may call from it.
 */
export function chosenLineIdFor(
  choice: CallLineChoice | null,
  userId: string | undefined,
): string | null {
  return choice && choice.userId === userId ? choice.lineId : null;
}

/** Whether a call can leave from here, and what to say when it cannot. */
export type CallEligibility =
  | { canCall: true; line: OutboundCallLine }
  | { canCall: false; reason: string };

/**
 * The line a call leaves from until the user picks another: a number of their
 * own, and otherwise the first department line, which the API lists with the
 * primary ones first. A user's own number is never marked primary; only a
 * department has a primary number.
 */
export function defaultCallLine(
  lines: readonly OutboundCallLine[],
): OutboundCallLine | null {
  return (
    lines.find((line) => line.ownerType === 'user') ??
    lines.find((line) => line.ownerType === 'department') ??
    null
  );
}

/**
 * For the dialer and the contacts list, where no conversation says which line
 * to use: the line the user chose, or the default. A choice that is no longer
 * offered, because the user left the department, falls back to the default.
 */
export function callFromChosenLine(
  callLines: CallLines,
  chosenLineId: string | null,
): CallEligibility {
  if (callLines.status !== 'loaded') {
    return { canCall: false, reason: WHY_NOT_LOADED[callLines.status] };
  }

  const line =
    callLines.lines.find((option) => option.id === chosenLineId) ??
    defaultCallLine(callLines.lines);

  return line ? { canCall: true, line } : { canCall: false, reason: NO_LINES };
}

/**
 * For a thread: the call leaves from the line the conversation is on, so the
 * other party sees the number they know and the call lands in the same
 * conversation. A thread can be readable without being callable, the way it
 * can be readable without being writable.
 */
export function callFromConversationLine(
  callLines: CallLines,
  linePhoneNumber: string,
): CallEligibility {
  if (callLines.status !== 'loaded') {
    return { canCall: false, reason: WHY_NOT_LOADED[callLines.status] };
  }
  if (callLines.lines.length === 0) {
    return { canCall: false, reason: NO_LINES };
  }

  const line = callLines.lines.find(
    (option) => option.phoneNumber === linePhoneNumber,
  );

  return line
    ? { canCall: true, line }
    : {
        canCall: false,
        reason: 'You cannot call from the number this conversation is on.',
      };
}

/**
 * For a call in the inbox, which has no thread to call from: back from the
 * line the call was on when the user may call from it, and otherwise like a
 * number typed in the dialer. The record of a call placed before calls had a
 * line names none, and a call a colleague took on a line of theirs is still
 * worth returning.
 */
export function callBackFromLine(
  callLines: CallLines,
  linePhoneNumber: string,
  chosenLineId: string | null,
): CallEligibility {
  const onTheLine = callFromConversationLine(callLines, linePhoneNumber);

  return onTheLine.canCall
    ? onTheLine
    : callFromChosenLine(callLines, chosenLineId);
}

/**
 * The same eligibility, narrowed to who would be called. A contact is whoever
 * wrote to us, and a service writes from a short code or from its own name;
 * neither is something a carrier can put a call through to. Having a line to
 * call from does not help when there is nothing at the other end, so the
 * contact is the reason the reader is given.
 */
export function callToContact(
  eligibility: CallEligibility,
  contactPhoneNumber: string,
): CallEligibility {
  return toE164PhoneNumber(contactPhoneNumber) === null
    ? { canCall: false, reason: NOT_CALLABLE }
    : eligibility;
}

const NOT_CALLABLE = 'This contact has no number to call.';

const NO_LINES =
  'You have no number to call from. Ask an administrator to assign you one.';

const WHY_NOT_LOADED = {
  loading: 'Loading the numbers you can call from…',
  'signed-out': 'You are not signed in.',
  failed: 'The numbers you can call from could not be loaded.',
} as const satisfies Record<Exclude<CallLines['status'], 'loaded'>, string>;
