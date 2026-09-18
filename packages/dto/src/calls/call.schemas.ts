import { z } from 'zod';
import {
  CallDirectionSchema,
  CallRecordingContextSchema,
  CallRecordingDeletionReasonSchema,
  CallStatusSchema,
  OwnerTypeSchema,
  TelephonyProviderSchema,
} from '../common/domain.js';
import {
  IsoDateTimeSchema,
  normalizePhoneNumber,
  QueryBooleanSchema,
} from '../common/primitives.js';

export const CALL_LIST_DEFAULT_LIMIT = 50;
export const CALL_LIST_MAX_LIMIT = 100;

export const CallConversationParamsSchema = z.object({
  conversationUuid: z.string().trim().min(1, 'Conversation is required'),
});

/** One recording of one call: what playback and deletion address. */
export const CallRecordingParamsSchema = CallConversationParamsSchema.extend({
  recordingId: z.string().trim().min(1, 'Recording is required'),
});

/**
 * A number a filter is matched on, normalised to the E.164 form the call
 * record stores, so a punctuated or ten-digit value still matches.
 */
const PhoneFilterSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    const normalized = normalizePhoneNumber(value);

    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Phone number must be a valid E.164 or 10-digit North American number',
      });
      return z.NEVER;
    }

    return normalized;
  });

/** A repeated query parameter arrives as an array, a single one as a string. */
const CallStatusFilterSchema = z
  .union([CallStatusSchema, z.array(CallStatusSchema).min(1)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

/**
 * Offset-based history list. Values arrive as strings from the query string.
 *
 * `linePhone` is one of our own numbers and `contactPhone` the other party;
 * each is matched against both legs, because which leg holds which depends on
 * the call's direction. Together they select the calls belonging to one
 * conversation, which is a (contact, line) pair.
 *
 * `hasVoicemail` selects the calls that left one. It is not the same as
 * having a recording: a conference recording is stored on the call too.
 */
export const CallListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CALL_LIST_MAX_LIMIT)
    .default(CALL_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  linePhone: PhoneFilterSchema.optional(),
  contactPhone: PhoneFilterSchema.optional(),
  status: CallStatusFilterSchema.optional(),
  direction: CallDirectionSchema.optional(),
  hasVoicemail: QueryBooleanSchema.optional(),
});

export const CallCommandResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

/**
 * The other party, when the directory knows them. Resolved from the number on
 * the far leg of the call; `Call` itself holds no reference to a contact.
 */
export const CallContactSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  phoneNumber: z.string(),
});

/**
 * Our own number the call was on. Resolved from the near leg, the way the
 * contact is resolved from the far one, and null when that number is no
 * longer one of ours. It carries the same fields as a conversation's source
 * number so both name a line the same way.
 */
export const CallLineSchema = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  label: z.string().nullable(),
});

/**
 * A number the current user may place calls from: their own, or one of a
 * department they belong to. It carries the fields a message sender does, so
 * the softphone names both the same way.
 */
export const OutboundCallLineSchema = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  label: z.string().nullable(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  ownerName: z.string(),
  isPrimary: z.boolean(),
});

export const OutboundCallLinesResponseSchema = z.object({
  lines: z.array(OutboundCallLineSchema),
});

/** When a recording's audio went, and what took it. */
export const CallRecordingDeletionSchema = z.object({
  reason: CallRecordingDeletionReasonSchema,
  at: IsoDateTimeSchema,
});

/**
 * A recording of a call, as a call's card shows it. No provider URL and no
 * object key: the audio is served by
 * `GET /api/calls/:conversationUuid/recordings/:recordingId`, which reads
 * whichever copy still exists.
 */
export const CallRecordingSummarySchema = z.object({
  id: z.string(),
  context: CallRecordingContextSchema,
  /** Seconds, as the provider measured it; null when it did not say. */
  duration: z.number().int().nonnegative().nullable(),
  /** Set once the audio is gone, so history says so instead of offering a player. */
  deletion: CallRecordingDeletionSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

/**
 * What the delete route answers: the deletion as it is stored, so a manual
 * delete that raced the retention sweep reports the sweep's reason rather
 * than the one the request asked for.
 */
export const RecordingDeletedResponseSchema = z.object({
  id: z.string(),
  deletion: CallRecordingDeletionSchema,
});

export const CallRecordSchema = z.object({
  id: z.string(),
  conversationUuid: z.string(),
  callerLegUuid: z.string().nullable(),
  agentLegUuid: z.string().nullable(),
  externalLegUuid: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  status: z.string(),
  duration: z.number().int().nonnegative().nullable(),
  transcript: z.string().nullable(),
  direction: CallDirectionSchema,
  provider: TelephonyProviderSchema,
  userId: z.string().nullable(),
  departmentId: z.string().nullable(),
  user: z.object({ id: z.string(), email: z.string() }).nullable(),
  department: z.object({ id: z.string(), name: z.string() }).nullable(),
  contact: CallContactSchema.nullable(),
  line: CallLineSchema.nullable(),
  /**
   * The caller left a voicemail, which `GET /api/calls/:conversationUuid/voicemail`
   * plays. Not the same as holding a recording: a conference recording is
   * stored on the call without being one. No recording URL is published:
   * it is the provider's, and the API serves the audio itself.
   */
  hasVoicemail: z.boolean(),
  /**
   * Every recording the call has, newest first, whether its audio is still
   * there or was deleted. `hasVoicemail` is not read from this: it comes from
   * the timeline, which a call from before recordings had rows of their own
   * still carries.
   */
  recordings: z.array(CallRecordingSummarySchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const CallListResponseSchema = z.object({
  calls: z.array(CallRecordSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});

export type CallConversationParams = z.infer<
  typeof CallConversationParamsSchema
>;
export type CallRecordingParams = z.infer<typeof CallRecordingParamsSchema>;
export type CallListQuery = z.infer<typeof CallListQuerySchema>;
export type CallCommandResponse = z.infer<typeof CallCommandResponseSchema>;
export type CallContact = z.infer<typeof CallContactSchema>;
export type CallRecordingDeletion = z.infer<typeof CallRecordingDeletionSchema>;
export type CallRecordingSummary = z.infer<typeof CallRecordingSummarySchema>;
export type RecordingDeletedResponse = z.infer<
  typeof RecordingDeletedResponseSchema
>;
export type CallLine = z.infer<typeof CallLineSchema>;
export type OutboundCallLine = z.infer<typeof OutboundCallLineSchema>;
export type OutboundCallLinesResponse = z.infer<
  typeof OutboundCallLinesResponseSchema
>;
export type CallRecord = z.infer<typeof CallRecordSchema>;
export type CallListResponse = z.infer<typeof CallListResponseSchema>;
