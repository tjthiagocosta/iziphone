import { VoiceHangupResponseSchema, VoiceTokenResponseSchema } from '@repo/dto';
import { requestCallController } from './client';

/** A Twilio access token that registers this browser as the user's device. */
export async function fetchVoiceToken(realtimeToken: string): Promise<string> {
  const { jwt } = await requestCallController('/api/voice/jwt', realtimeToken, {
    schema: VoiceTokenResponseSchema,
  });
  return jwt;
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
