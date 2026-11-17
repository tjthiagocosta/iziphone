import type { ReconnectReason, TextingNote } from '@repo/dto';

/** Where this deployment wants a number's calls and texts. */
export interface WebhookAddresses {
  messagesInbound: string;
  voice: string;
  voiceFallback: string;
  /**
   * The number's own status callback, which Twilio sends for the calls to
   * it. Message status is asked for on each message sent instead.
   */
  voiceStatus: string;
}

/**
 * What a Twilio number carries that decides where its calls and texts go:
 * every field that pointing it here writes or clears, so that what it had
 * before can be written down and put back by hand.
 */
export interface NumberSettings {
  voiceUrl: string | null;
  voiceMethod: string | null;
  voiceFallbackUrl: string | null;
  voiceFallbackMethod: string | null;
  statusCallback: string | null;
  statusCallbackMethod: string | null;
  smsUrl: string | null;
  smsMethod: string | null;
  voiceApplicationSid: string | null;
  smsApplicationSid: string | null;
  trunkSid: string | null;
}

/** A messaging service, as far as where its senders' inbound texts go. */
export interface MessagingServiceRef {
  sid: string;
  friendlyName: string;
  /** False: the service sends its senders' inbound texts to its own address. */
  useInboundWebhookOnNumber: boolean;
  /** That address of its own, used when the flag is false. */
  inboundRequestUrl: string | null;
  /** How Twilio calls that address; null is Twilio's default, POST. */
  inboundMethod: string | null;
}

/**
 * Why the number's calls or texts would not reach this deployment, in a fixed
 * order. A webhook counts only at its address and called with POST, the only
 * method the webhook routes take. Twilio uses an attached application or SIP
 * trunk instead of the number's webhooks, so either one counts even when the
 * webhooks are right.
 */
export function reconnectReasons(
  settings: NumberSettings,
  expected: WebhookAddresses,
): ReconnectReason[] {
  const reasons: ReconnectReason[] = [];

  if (!postsTo(settings.voiceUrl, settings.voiceMethod, expected.voice)) {
    reasons.push('voice-url');
  }
  if (
    !postsTo(
      settings.voiceFallbackUrl,
      settings.voiceFallbackMethod,
      expected.voiceFallback,
    )
  ) {
    reasons.push('voice-fallback-url');
  }
  if (
    !postsTo(
      settings.statusCallback,
      settings.statusCallbackMethod,
      expected.voiceStatus,
    )
  ) {
    reasons.push('status-callback');
  }
  if (!postsTo(settings.smsUrl, settings.smsMethod, expected.messagesInbound)) {
    reasons.push('sms-url');
  }
  if (settings.voiceApplicationSid) {
    reasons.push('voice-application');
  }
  if (detachableSmsApplication(settings.smsApplicationSid)) {
    reasons.push('sms-application');
  }
  if (settings.trunkSid) {
    reasons.push('sip-trunk');
  }

  return reasons;
}

/**
 * The update that points the number here and takes off whatever would win
 * over its webhooks. Only what is attached is cleared, so an update never
 * touches a setting the number does not have.
 */
export function connectingUpdate(
  settings: NumberSettings,
  expected: WebhookAddresses,
): Record<string, string> {
  return {
    smsUrl: expected.messagesInbound,
    smsMethod: 'POST',
    statusCallback: expected.voiceStatus,
    statusCallbackMethod: 'POST',
    voiceUrl: expected.voice,
    voiceMethod: 'POST',
    voiceFallbackUrl: expected.voiceFallback,
    voiceFallbackMethod: 'POST',
    // Twilio clears a reference given as an empty string.
    ...(settings.voiceApplicationSid ? { voiceApplicationSid: '' } : {}),
    ...(detachableSmsApplication(settings.smsApplicationSid)
      ? { smsApplicationSid: '' }
      : {}),
    ...(settings.trunkSid ? { trunkSid: '' } : {}),
  };
}

/**
 * What may keep the number's texts from arriving although its webhooks are
 * right. `service` is the messaging service sending from it, null for none,
 * or `unknown` when the services could not be read. A service that keeps its
 * senders' texts but sends them to `messagesInbound` itself is no obstacle.
 */
export function textingNote(
  number: { local: boolean; texts: boolean },
  service: MessagingServiceRef | null | 'unknown',
  messagesInbound: string,
): TextingNote | null {
  if (!number.texts) {
    return null;
  }
  if (service === 'unknown') {
    return { kind: 'unknown' };
  }
  if (service === null) {
    // A toll-free number is verified on its own, not through a service.
    return number.local ? { kind: 'unregistered' } : null;
  }

  return service.useInboundWebhookOnNumber ||
    postsTo(service.inboundRequestUrl, service.inboundMethod, messagesInbound)
    ? null
    : {
        kind: 'service-takes-texts',
        service: { sid: service.sid, friendlyName: service.friendlyName },
      };
}

const RECONNECT_REASON_TEXT: Record<ReconnectReason, string> = {
  'voice-url': 'its voice URL points elsewhere or is not called with POST',
  'voice-fallback-url':
    'its voice fallback URL points elsewhere or is not called with POST',
  'status-callback':
    'its status callback points elsewhere or is not called with POST',
  'sms-url': 'its messaging URL points elsewhere or is not called with POST',
  'voice-application': 'a TwiML App takes its calls',
  'sms-application': 'an application takes its texts',
  'sip-trunk': 'a SIP trunk takes its calls',
};

/** One readiness issue line for a number that needs Reconnect. */
export function describeReconnect(
  phoneNumber: string,
  reasons: readonly ReconnectReason[],
): string {
  return `${phoneNumber} needs Reconnect: ${reasons
    .map((reason) => RECONNECT_REASON_TEXT[reason])
    .join(', ')}`;
}

/** One readiness warning line for a texting note. */
export function describeTextingNote(
  phoneNumber: string,
  note: TextingNote,
): string {
  switch (note.kind) {
    case 'service-takes-texts':
      return `${phoneNumber}: the messaging service "${note.service.friendlyName}" sends this number's inbound texts to its own address, so they do not reach this deployment. In the Twilio Console, set the service's incoming messages to "Defer to sender's webhook", or take the number out of the service.`;
    case 'unregistered':
      return `${phoneNumber} is in no messaging service: US carriers block texts from an unregistered local number (A2P 10DLC), so it can call but not text until it joins the messaging service of a registered campaign in the Twilio Console.`;
    case 'unknown':
      return `${phoneNumber}: the account's messaging services could not be read, so whether its texts arrive was not checked.`;
  }
}

/**
 * The SMS application to take off a number, if any. Twilio has not been seen
 * to name a number's messaging service there (the readiness check finds the
 * service from the services' side for that reason), but should a messaging
 * service sid ever appear, it is left alone: the service carries the
 * number's A2P registration, and only the Twilio Console changes it.
 */
export function detachableSmsApplication(
  smsApplicationSid: string | null,
): string | null {
  return smsApplicationSid && !smsApplicationSid.startsWith('MG')
    ? smsApplicationSid
    : null;
}

function postsTo(
  url: string | null,
  method: string | null,
  expected: string,
): boolean {
  // Twilio calls a webhook with POST unless told otherwise.
  return (
    normalizeUrl(url) === expected &&
    (method ?? 'POST').toUpperCase() === 'POST'
  );
}

// A trailing slash is not forgiven: neither service ignores one when it
// matches a route, so Twilio would get a 404 at that address.
function normalizeUrl(value: string | null): string | null {
  return (value || '').trim() || null;
}
