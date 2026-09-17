import {
  type E164PhoneNumber,
  type OutboundGrantRefusal,
  toE164PhoneNumber,
} from '@repo/dto';
import { type CachedRouting, OUTBOUND_GRANT } from '@repo/events';
import { z } from 'zod';
import { planOutboundCall } from '../routing/index.js';

/*
 * The grant an outbound call is placed on. Before the softphone dials, it
 * asks this service over the authenticated API whether the agent may call
 * that number from that line, and gets a grant. It hands the grant to Twilio
 * with the call, and Twilio's webhook brings it back. Who is calling, whom
 * and from where are then read from the grant, which only the agent it was
 * issued to could have obtained. The call's own parameters, `From` included,
 * are the browser's to set and prove nothing.
 *
 * Deciding and admitting are pure; keeping the grant and taking it back are
 * the telephony service's.
 */

export interface OutboundCallGrant {
  userId: string;
  to: E164PhoneNumber;
  /** The line the call leaves from: its caller ID, and the line it is kept on. */
  fromNumber: E164PhoneNumber;
  /** Set when the line is a department's, so the call belongs to it. */
  departmentId?: string;
  departmentName?: string;
  createdAt: string;
}

export interface OutboundGrantRequest {
  userId: string;
  to: E164PhoneNumber;
  fromNumber: E164PhoneNumber;
}

export type OutboundGrantDecision =
  | { action: 'refuse'; reason: OutboundGrantRefusal }
  | { action: 'issue'; grant: OutboundCallGrant };

/** What the agent is told when the grant is refused, next to its code. */
export const OUTBOUND_GRANT_REFUSAL_MESSAGES: Record<
  OutboundGrantRefusal,
  string
> = {
  'line-unavailable': 'The number you are calling from is not available',
  'line-without-voice': 'The number you are calling from cannot place calls',
  'line-not-allowed': 'You are not allowed to call from that number',
};

/**
 * Whether to grant the call. Pure: `routing` is the entry of the line the
 * agent named, and null when there is none. The grant remembers the line's
 * department, so the webhook needs no second look at the routing.
 */
export function decideOutboundGrant(
  request: OutboundGrantRequest,
  routing: CachedRouting | null,
  now: Date,
): OutboundGrantDecision {
  const plan = planOutboundCall(
    { agentUserId: request.userId, line: request.fromNumber },
    routing,
  );
  if (plan.action === 'refuse') {
    return plan;
  }

  return {
    action: 'issue',
    grant: {
      userId: request.userId,
      to: request.to,
      fromNumber: plan.line,
      departmentId: plan.departmentId,
      departmentName: plan.departmentName,
      createdAt: now.toISOString(),
    },
  };
}

/** Why a call that reached the webhook was not placed; the agent hears it. */
export type OutboundCallRefusal = 'no-grant' | 'grant-expired' | 'wrong-caller';

const OUTBOUND_CALL_REFUSAL_MESSAGES: Record<OutboundCallRefusal, string> = {
  'no-grant':
    'Your call was not placed. Please start it again from the softphone.',
  'grant-expired':
    'Your call was not placed. Starting it took too long. Please try again.',
  'wrong-caller':
    'Your call was not placed. It did not come from the softphone it was granted to.',
};

export function outboundCallRefusalMessage(
  reason: OutboundCallRefusal,
): string {
  return OUTBOUND_CALL_REFUSAL_MESSAGES[reason];
}

export type OutboundCallAdmission =
  | { action: 'refuse'; reason: OutboundCallRefusal }
  | { action: 'dial'; grant: OutboundCallGrant };

const CLIENT_SCHEME = 'client:';

/**
 * Whether the call Twilio is asking about may go ahead. `grant` is what was
 * kept for the token the call carries, taken back in the same step so that a
 * grant serves one call; null covers a token never issued, used already, or
 * expired. The age check repeats what the store's TTL does, so that the rule
 * holds on its own.
 *
 * `from` is Twilio's caller, `client:<identity>` for a softphone. The browser
 * can set it, so a match proves nothing; a mismatch is still refused, as a
 * second line behind the grant.
 */
export function admitOutboundCall(
  grant: OutboundCallGrant | null,
  from: string | undefined,
  now: Date,
): OutboundCallAdmission {
  if (!grant) {
    return { action: 'refuse', reason: 'no-grant' };
  }
  const expiresAt =
    Date.parse(grant.createdAt) + OUTBOUND_GRANT.TTL_SECONDS * 1000;
  if (!(now.getTime() < expiresAt)) {
    return { action: 'refuse', reason: 'grant-expired' };
  }
  if (from !== `${CLIENT_SCHEME}${grant.userId}`) {
    return { action: 'refuse', reason: 'wrong-caller' };
  }
  return { action: 'dial', grant };
}

const e164 = z.string().transform((value, context) => {
  const number = toE164PhoneNumber(value);
  if (!number) {
    context.addIssue({ code: 'custom', message: 'Not an E.164 number' });
    return z.NEVER;
  }
  return number;
});

const StoredGrantSchema = z.object({
  userId: z.string().min(1),
  to: e164,
  fromNumber: e164,
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  createdAt: z.iso.datetime({ offset: true }),
});

/** A grant as it comes back from the store, or null when it is not one. */
export function parseStoredGrant(value: unknown): OutboundCallGrant | null {
  const parsed = StoredGrantSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
