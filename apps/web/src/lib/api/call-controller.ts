import {
  AVAILABILITY_LOOKUP_MAX_USERS,
  AvailabilityLookupResponseSchema,
  type DoNotDisturb,
  type HoldCall,
  type OutboundGrantRequest,
  OutboundGrantResponseSchema,
  type OwnAvailabilityResponse,
  OwnAvailabilityResponseSchema,
  type TransferCall,
  type UserAvailability,
  VoiceHangupResponseSchema,
  VoiceHoldResponseSchema,
  VoiceTokenResponseSchema,
  VoiceTransferCancelResponseSchema,
  VoiceTransferResponseSchema,
} from '@repo/dto';
import { requestCallController, withQuery } from './client';

/** A Twilio access token that registers this browser as the user's device. */
export async function fetchVoiceToken(realtimeToken: string): Promise<string> {
  const { jwt } = await requestCallController('/api/voice/jwt', realtimeToken, {
    schema: VoiceTokenResponseSchema,
  });
  return jwt;
}

/**
 * Asks the controller for the grant a call to `to` from `fromNumber` is
 * placed on; the device then starts the call with it. A refusal is an
 * `ApiError` whose `code` is an `OutboundGrantRefusal` and whose message says
 * why in the user's terms.
 */
export async function requestOutboundGrant(
  realtimeToken: string,
  to: string,
  fromNumber: string,
): Promise<string> {
  const { grant } = await requestCallController(
    '/api/voice/outbound-grants',
    realtimeToken,
    {
      method: 'POST',
      body: { to, fromNumber } satisfies OutboundGrantRequest,
      schema: OutboundGrantResponseSchema,
    },
  );
  return grant;
}

/**
 * Asks the controller to end the conversation this leg belongs to, so the
 * other parties are released at once instead of when Twilio reports the leg.
 */
export async function requestHangup(
  realtimeToken: string,
  legSid: string,
): Promise<void> {
  await requestCallController(
    `/api/voice/calls/${encodeURIComponent(legSid)}/hangup`,
    realtimeToken,
    { method: 'POST', schema: VoiceHangupResponseSchema },
  );
}

/*
 * Hold and transfer are asked of the controller the way a hangup is: by the
 * user's own leg, which is what proves they are the agent on the call. A
 * refusal is an `ApiError` whose `code` is a `CallControlRefusal`.
 */

/** Holds or resumes the other party. Resolves to whether they are held now. */
export async function requestHold(
  realtimeToken: string,
  legSid: string,
  hold: boolean,
): Promise<boolean> {
  const { held } = await requestCallController(
    `/api/voice/calls/${encodeURIComponent(legSid)}/hold`,
    realtimeToken,
    {
      method: 'POST',
      body: { hold } satisfies HoldCall,
      schema: VoiceHoldResponseSchema,
    },
  );
  return held;
}

/**
 * Rings a teammate to take the call over. Resolves once they ring; how it
 * went arrives later as a `call_transfer_outcome` on the socket.
 */
export async function requestTransfer(
  realtimeToken: string,
  legSid: string,
  targetUserId: string,
): Promise<{ conversationUuid: string }> {
  const { conversationUuid } = await requestCallController(
    `/api/voice/calls/${encodeURIComponent(legSid)}/transfer`,
    realtimeToken,
    {
      method: 'POST',
      body: { targetUserId } satisfies TransferCall,
      schema: VoiceTransferResponseSchema,
    },
  );
  return { conversationUuid };
}

/** Stops ringing the teammate and brings the other party back. */
export async function requestTransferCancel(
  realtimeToken: string,
  legSid: string,
): Promise<void> {
  await requestCallController(
    `/api/voice/calls/${encodeURIComponent(legSid)}/transfer/cancel`,
    realtimeToken,
    { method: 'POST', schema: VoiceTransferCancelResponseSchema },
  );
}

/*
 * Availability is the controller's to decide; the softphone only shows it.
 * The transfer picker asks about teammates, and the status menu about the
 * user and their do not disturb.
 */

/** Where each of these teammates stands now, in as few requests as fit. */
export async function fetchAvailability(
  realtimeToken: string,
  userIds: readonly string[],
): Promise<UserAvailability[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += AVAILABILITY_LOOKUP_MAX_USERS) {
    chunks.push(userIds.slice(i, i + AVAILABILITY_LOOKUP_MAX_USERS));
  }

  const answers = await Promise.all(
    chunks.map((chunk) =>
      requestCallController(
        withQuery('/api/voice/availability', { userIds: chunk.join(',') }),
        realtimeToken,
        { schema: AvailabilityLookupResponseSchema },
      ),
    ),
  );
  return answers.flatMap(({ users }) => users);
}

export function fetchOwnAvailability(
  realtimeToken: string,
): Promise<OwnAvailabilityResponse> {
  return requestCallController('/api/voice/availability/me', realtimeToken, {
    schema: OwnAvailabilityResponseSchema,
  });
}

/** Turns do not disturb on or off on every device of the user. */
export function requestDoNotDisturb(
  realtimeToken: string,
  doNotDisturb: boolean,
): Promise<OwnAvailabilityResponse> {
  return requestCallController(
    '/api/voice/availability/me/do-not-disturb',
    realtimeToken,
    {
      method: 'PUT',
      body: { doNotDisturb } satisfies DoNotDisturb,
      schema: OwnAvailabilityResponseSchema,
    },
  );
}
