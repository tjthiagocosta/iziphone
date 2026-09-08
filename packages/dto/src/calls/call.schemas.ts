import { z } from 'zod';
import {
  CallDirectionSchema,
  TelephonyProviderSchema,
} from '../common/domain.js';
import { EntityIdSchema, IsoDateTimeSchema } from '../common/primitives.js';

export const CALL_LIST_DEFAULT_LIMIT = 50;
export const CALL_LIST_MAX_LIMIT = 100;

export const CallConversationParamsSchema = z.object({
  conversationUuid: z.string().trim().min(1, 'Conversation is required'),
});

/** Offset-based history list. Values arrive as strings from the query string. */
export const CallListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CALL_LIST_MAX_LIMIT)
    .default(CALL_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const TransferCallSchema = z.object({
  targetUserId: EntityIdSchema,
});

export const HoldCallSchema = z.object({
  hold: z.boolean(),
});

export const CallCommandResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
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
  recordingUrl: z.string().nullable(),
  transcript: z.string().nullable(),
  direction: CallDirectionSchema,
  provider: TelephonyProviderSchema,
  userId: z.string().nullable(),
  departmentId: z.string().nullable(),
  user: z.object({ id: z.string(), email: z.string() }).nullable(),
  department: z.object({ id: z.string(), name: z.string() }).nullable(),
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
export type CallListQuery = z.infer<typeof CallListQuerySchema>;
export type TransferCall = z.infer<typeof TransferCallSchema>;
export type HoldCall = z.infer<typeof HoldCallSchema>;
export type CallCommandResponse = z.infer<typeof CallCommandResponseSchema>;
export type CallRecord = z.infer<typeof CallRecordSchema>;
export type CallListResponse = z.infer<typeof CallListResponseSchema>;
