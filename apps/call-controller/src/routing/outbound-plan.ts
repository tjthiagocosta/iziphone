import type { E164PhoneNumber, OutboundGrantRefusal } from '@repo/dto';
import type { CachedRouting } from '@repo/events';

/*
 * Whether an agent may place a call from a line, and what that call looks
 * like. The softphone names the line, but the softphone is a browser: the
 * routing entry of the number decides, the same entry that says whom the
 * number rings. Whoever answers a line may call from it, and nobody else.
 */

export interface OutboundCallAttempt {
  agentUserId: string;
  line: E164PhoneNumber;
}

export type OutboundCallPlan =
  | { action: 'refuse'; reason: OutboundGrantRefusal }
  | {
      action: 'dial';
      /** The caller ID the other party sees, and the line the call is kept on. */
      line: E164PhoneNumber;
      /** Set when the line is a department's, so the call belongs to it. */
      departmentId?: string;
      departmentName?: string;
    };

/**
 * Decide whether the call may leave from the line. Pure: `routing` is the
 * entry of `attempt.line`, and null when there is none, which covers a number
 * that is not ours, one that is unassigned or inactive, and a lookup that
 * failed. None of them may be dialed from, so there is no line to fall back to.
 */
export function planOutboundCall(
  attempt: OutboundCallAttempt,
  routing: CachedRouting | null,
): OutboundCallPlan {
  if (!routing) {
    return { action: 'refuse', reason: 'line-unavailable' };
  }
  if (!routing.userIds.includes(attempt.agentUserId)) {
    return { action: 'refuse', reason: 'line-not-allowed' };
  }
  // Only an entry that says so. One written before the flag existed says
  // nothing and stays a cache hit for its whole TTL, so reading silence as a
  // no would refuse every call of the deployment if the API's warm-up failed.
  // Who may call is decided above either way, and Twilio rejects a caller ID
  // that cannot place calls.
  if (routing.voiceEnabled === false) {
    return { action: 'refuse', reason: 'line-without-voice' };
  }

  if (routing.type === 'DEPARTMENT') {
    return {
      action: 'dial',
      line: attempt.line,
      departmentId: routing.departmentId,
      departmentName: routing.departmentName,
    };
  }

  return { action: 'dial', line: attempt.line };
}
