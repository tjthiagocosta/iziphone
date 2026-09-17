import { z } from 'zod';
import { EntityIdSchema } from '../common/primitives.js';

/*
 * What the softphone and the call controller say to each other directly: a
 * Twilio access token to register the browser, and the controls an agent has
 * over a call they are on (hang up, hold, transfer). Every route is
 * authenticated with the realtime JWT the API issued and addressed by the
 * agent's own leg, so the controller can check the request against the live
 * call.
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

/** `true` puts the other party on hold, `false` brings them back. */
export const HoldCallSchema = z.object({
  hold: z.boolean(),
});

export const VoiceHoldResponseSchema = z.object({
  success: z.literal(true),
  conversationUuid: z.string(),
  /** Whether the other party is on hold now, as the provider reported it. */
  held: z.boolean(),
});

export const TransferCallSchema = z.object({
  targetUserId: EntityIdSchema,
});

/** The teammate is ringing; how it ends arrives as `call_transfer_outcome`. */
export const VoiceTransferResponseSchema = z.object({
  success: z.literal(true),
  conversationUuid: z.string(),
  targetUserId: z.string(),
});

export const VoiceTransferCancelResponseSchema = z.object({
  success: z.literal(true),
  conversationUuid: z.string(),
});

/**
 * Why the controller refused a hold, a transfer or a cancel. Sent as `code`
 * next to a readable `message`, so the softphone can word the ones that name
 * a teammate itself.
 */
export const CallControlRefusalSchema = z.enum([
  'leg-not-found',
  'not-on-call',
  'not-connected',
  'transfer-pending',
  'no-transfer-pending',
  'transfer-to-self',
  'target-on-call',
  'target-offline',
  'call-gone',
  'provider-error',
]);

export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponseSchema>;
export type VoiceHangupResponse = z.infer<typeof VoiceHangupResponseSchema>;
export type HoldCall = z.infer<typeof HoldCallSchema>;
export type VoiceHoldResponse = z.infer<typeof VoiceHoldResponseSchema>;
export type TransferCall = z.infer<typeof TransferCallSchema>;
export type VoiceTransferResponse = z.infer<typeof VoiceTransferResponseSchema>;
export type VoiceTransferCancelResponse = z.infer<
  typeof VoiceTransferCancelResponseSchema
>;
export type CallControlRefusal = z.infer<typeof CallControlRefusalSchema>;
