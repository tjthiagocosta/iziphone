import {
  type HoldCall,
  type OutboundGrantRequest,
  OutboundGrantResponseSchema,
  type TransferCall,
  VoiceHangupResponseSchema,
  VoiceHoldResponseSchema,
  VoiceTokenResponseSchema,
  VoiceTransferCancelResponseSchema,
  VoiceTransferResponseSchema,
} from '@repo/dto';
import { requestCallController } from './client';

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
