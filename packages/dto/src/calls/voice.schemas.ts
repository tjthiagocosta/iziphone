import { z } from 'zod';
import {
  E164PhoneNumberSchema,
  EntityIdSchema,
  PhoneNumberInputSchema,
} from '../common/primitives.js';
import { UserAvailabilitySchema } from '../socket/payloads.js';

/*
 * What the softphone and the call controller say to each other directly: a
 * Twilio access token to register the browser, the grant an outbound call is
 * placed on, and the controls an agent has over a call they are on (hang up,
 * hold, transfer). Every route is authenticated with the realtime JWT the API
 * issued and, past the first two, addressed by the agent's own leg, so the
 * controller can check the request against the live call.
 */

export const VoiceTokenResponseSchema = z.object({
  jwt: z.string().min(1),
  /** The Twilio client identity, which is the user id. */
  identity: z.string().min(1),
  provider: z.literal('twilio'),
});

/**
 * What an agent asks before dialing out: the number to call and the line to
 * call from. The controller decides whether they may, and answers with a
 * grant the softphone hands to Twilio when it starts the call. Twilio's
 * webhook then reads the caller, the destination and the line from the grant
 * and not from the call, whose parameters the browser can set to anything.
 */
export const OutboundGrantRequestSchema = z.object({
  to: PhoneNumberInputSchema,
  fromNumber: E164PhoneNumberSchema,
});

export const OutboundGrantResponseSchema = z.object({
  /** Good for one call, started within the seconds given. */
  grant: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
});

/**
 * Why the controller would not let a call leave from the line: the number is
 * not one of ours or could not be looked up, it does not do voice, or the
 * agent is not among the people it rings.
 */
export const OutboundGrantRefusalSchema = z.enum([
  'line-unavailable',
  'line-without-voice',
  'line-not-allowed',
]);

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
  /** The teammate is on, or being offered, another call. */
  'target-busy',
  /** The teammate turned do not disturb on. */
  'target-dnd',
  'target-offline',
  'call-gone',
  'provider-error',
]);

/** Most teammates one availability request may ask about. */
export const AVAILABILITY_LOOKUP_MAX_USERS = 200;

/**
 * Which teammates to report on, as a comma-separated list of user ids, the
 * way the transfer picker asks before it lets anybody be chosen.
 */
export const AvailabilityLookupQuerySchema = z.object({
  userIds: z
    .string()
    .transform((list) => [
      ...new Set(
        list
          .split(',')
          .map((userId) => userId.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(EntityIdSchema).min(1).max(AVAILABILITY_LOOKUP_MAX_USERS)),
});

export const AvailabilityLookupResponseSchema = z.object({
  users: z.array(UserAvailabilitySchema),
});

/** Turns the asking user's do not disturb on or off, on all their devices. */
export const DoNotDisturbSchema = z.object({
  doNotDisturb: z.boolean(),
});

/**
 * The asking user's own availability. Do not disturb is given apart from the
 * state because `offline` outranks it, and the softphone asks for this in
 * the same moment its socket registers: the controller may not count the
 * socket yet, and the state read then says offline whatever the switch is.
 */
export const OwnAvailabilityResponseSchema = z.object({
  availability: UserAvailabilitySchema,
  doNotDisturb: z.boolean(),
});

export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponseSchema>;
export type OutboundGrantRequest = z.infer<typeof OutboundGrantRequestSchema>;
export type OutboundGrantResponse = z.infer<typeof OutboundGrantResponseSchema>;
export type OutboundGrantRefusal = z.infer<typeof OutboundGrantRefusalSchema>;
export type VoiceHangupResponse = z.infer<typeof VoiceHangupResponseSchema>;
export type HoldCall = z.infer<typeof HoldCallSchema>;
export type VoiceHoldResponse = z.infer<typeof VoiceHoldResponseSchema>;
export type TransferCall = z.infer<typeof TransferCallSchema>;
export type VoiceTransferResponse = z.infer<typeof VoiceTransferResponseSchema>;
export type VoiceTransferCancelResponse = z.infer<
  typeof VoiceTransferCancelResponseSchema
>;
export type CallControlRefusal = z.infer<typeof CallControlRefusalSchema>;
export type AvailabilityLookupQuery = z.infer<
  typeof AvailabilityLookupQuerySchema
>;
export type AvailabilityLookupResponse = z.infer<
  typeof AvailabilityLookupResponseSchema
>;
export type DoNotDisturb = z.infer<typeof DoNotDisturbSchema>;
export type OwnAvailabilityResponse = z.infer<
  typeof OwnAvailabilityResponseSchema
>;
