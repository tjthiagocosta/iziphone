import { z } from 'zod';

/*
 * What the call controller answers the softphone directly: a Twilio access
 * token to register the browser, and the acknowledgement of a hangup request.
 * Both routes are authenticated with the realtime JWT the API issued.
 */

export const VoiceTokenResponseSchema = z.object({
  jwt: z.string().min(1),
  /** The Twilio client identity, which is the user id. */
  identity: z.string().min(1),
  provider: z.literal('twilio'),
});

export const VoiceHangupResponseSchema = z.object({
  success: z.literal(true),
  legUuid: z.string(),
  /** Absent when the controller no longer had state for the call. */
  conversationUuid: z.string().optional(),
});

export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponseSchema>;
export type VoiceHangupResponse = z.infer<typeof VoiceHangupResponseSchema>;
