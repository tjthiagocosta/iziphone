import type { OpenHoursRoutingType } from '@repo/dto';
import type { CachedRouting } from '@repo/events';
import {
  type BusinessHoursStatus,
  checkBusinessHours,
} from './business-hours.js';

/*
 * Why a caller ended up in voicemail. The call controller passes the reason
 * back to itself in webhook URLs and picks the greeting from it.
 */
export type VoicemailReason =
  | 'missing-routing'
  | 'closed-hours'
  | 'closed-hours-external'
  | 'user-unavailable'
  | 'fixed-order-unavailable'
  | 'no-agents'
  | 'routing-timeout';

const GREETINGS: Record<VoicemailReason, string> = {
  'missing-routing':
    'This number is not configured. Please leave a message after the tone.',
  'closed-hours':
    'We are currently closed. Please leave a message after the tone.',
  'closed-hours-external':
    'Nobody is available right now. Please leave a message after the tone.',
  'user-unavailable':
    'The person you are calling is unavailable. Please leave a message after the tone.',
  'fixed-order-unavailable':
    'Nobody is available right now. Please leave a message after the tone.',
  'no-agents':
    'Nobody is available right now. Please leave a message after the tone.',
  'routing-timeout':
    'Nobody is available right now. Please leave a message after the tone.',
};

export function voicemailGreeting(reason: VoicemailReason): string {
  return GREETINGS[reason];
}

/**
 * Every reason there is. The voicemail TwiML carries the reason in its
 * callbacks, so its size can only be bounded by looking at all of them.
 */
export const VOICEMAIL_REASONS: readonly VoicemailReason[] = Object.keys(
  GREETINGS,
) as VoicemailReason[];

/** What a caller hears before the beep. */
export type VoicemailGreeting =
  | { kind: 'recording'; url: string }
  | { kind: 'spoken'; text: string };

/**
 * The greeting URL of a routing entry, if it is one Twilio can be pointed at.
 * The cache types it as any string, so anything but an absolute http(s) URL
 * counts as no greeting rather than reaching the caller as broken audio. The
 * normalized form is ASCII, which keeps odd characters out of the TwiML.
 */
export function usableGreetingUrl(
  cached: string | null | undefined,
): string | undefined {
  const url = cached ? URL.parse(cached) : null;

  return url?.protocol === 'http:' || url?.protocol === 'https:'
    ? url.href
    : undefined;
}

/**
 * A department's own recording replaces the built-in greeting whatever sent
 * the caller to voicemail; without one the reason picks the words.
 */
export function chooseVoicemailGreeting(
  reason: VoicemailReason,
  customGreetingUrl: string | undefined,
): VoicemailGreeting {
  return customGreetingUrl
    ? { kind: 'recording', url: customGreetingUrl }
    : { kind: 'spoken', text: voicemailGreeting(reason) };
}

export type InboundCallPlan =
  | { action: 'voicemail'; reason: 'closed-hours' }
  | { action: 'forward'; phoneNumber: string; ringDuration: number }
  | {
      action: 'ring';
      strategy: OpenHoursRoutingType;
      /** In ring order for FIXED_ORDER; order is irrelevant otherwise. */
      userIds: string[];
      ringDuration: number | undefined;
      whenNobodyIsOnline: Extract<
        VoicemailReason,
        'user-unavailable' | 'fixed-order-unavailable' | 'no-agents'
      >;
    };

/**
 * Decide what to do with a call to a routed number. Pure: the same routing
 * and instant always give the same plan.
 */
export function planInboundCall(
  routing: CachedRouting,
  now: Date = new Date(),
): InboundCallPlan {
  if (routing.type === 'USER') {
    return {
      action: 'ring',
      strategy: 'SIMULTANEOUS',
      userIds: routing.userIds,
      ringDuration: routing.settings?.ringDuration,
      whenNobodyIsOnline: 'user-unavailable',
    };
  }

  const settings = routing.settings;
  const status: BusinessHoursStatus = settings
    ? checkBusinessHours(settings, now)
    : { isOpen: true };

  if (settings && !status.isOpen) {
    const closed =
      status.closedReason === 'HOLIDAY'
        ? status.holiday
        : {
            routingType: settings.closedHoursRoutingType,
            routingValue: settings.closedHoursExternalNumber,
          };

    if (closed.routingType === 'EXTERNAL_NUMBER' && closed.routingValue) {
      return {
        action: 'forward',
        phoneNumber: closed.routingValue,
        ringDuration: settings.ringDuration,
      };
    }

    return { action: 'voicemail', reason: 'closed-hours' };
  }

  if (settings?.openHoursRoutingType === 'FIXED_ORDER') {
    const ordered = routing.orderedUsers
      ? [...routing.orderedUsers]
          .sort((left, right) => left.order - right.order)
          .map((user) => user.userId)
      : routing.userIds;

    return {
      action: 'ring',
      strategy: 'FIXED_ORDER',
      userIds: ordered,
      ringDuration: settings.ringDuration,
      whenNobodyIsOnline: 'fixed-order-unavailable',
    };
  }

  return {
    action: 'ring',
    strategy: 'SIMULTANEOUS',
    userIds: routing.userIds,
    ringDuration: settings?.ringDuration,
    whenNobodyIsOnline: 'no-agents',
  };
}
