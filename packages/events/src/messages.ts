import {
  CallDirectionSchema,
  CallEndStatusSchema,
  IsoDateTimeSchema,
} from '@repo/dto';
import { z } from 'zod';
import type { Channel, CommandChannel, EventChannel } from './channels.js';

// ---------------------------------------------------------------------------
// Events (call controller -> API)
// ---------------------------------------------------------------------------

export const CallIncomingEventSchema = z.object({
  conversationUuid: z.string(),
  from: z.string(),
  to: z.string(),
  direction: CallDirectionSchema.default('inbound'),
  callerLegUuid: z.string().optional(),
  agentLegUuid: z.string().optional(),
  departmentId: z.string().optional(),
  userId: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallIncomingEvent = z.infer<typeof CallIncomingEventSchema>;

export const CallStartedEventSchema = z.object({
  conversationUuid: z.string(),
  from: z.string(),
  to: z.string(),
  userId: z.string(),
  departmentId: z.string().optional(),
  direction: CallDirectionSchema,
  agentLegUuid: z.string().optional(),
  externalLegUuid: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallStartedEvent = z.infer<typeof CallStartedEventSchema>;

export const CallEndedEventSchema = z.object({
  conversationUuid: z.string(),
  duration: z.number().int().nonnegative(),
  status: CallEndStatusSchema,
  callerLegUuid: z.string().optional(),
  agentLegUuid: z.string().optional(),
  externalLegUuid: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallEndedEvent = z.infer<typeof CallEndedEventSchema>;

export const CallMissedEventSchema = z.object({
  conversationUuid: z.string(),
  from: z.string(),
  to: z.string().optional(),
  departmentId: z.string().optional(),
  userId: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallMissedEvent = z.infer<typeof CallMissedEventSchema>;

export const CallTransferredEventSchema = z.object({
  conversationUuid: z.string(),
  fromUserId: z.string(),
  toUserId: z.string(),
  agentLegUuid: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallTransferredEvent = z.infer<typeof CallTransferredEventSchema>;

/** The shape of both `call:held` and `call:resumed`. */
export const CallHoldEventSchema = z.object({
  conversationUuid: z.string(),
  /**
   * The agent who pressed hold or resume, or who started the transfer that
   * held the call. Absent when the controller resumed the call by itself,
   * because a transfer was answered or fell through.
   */
  userId: z.string().optional(),
  /** The leg that was held or resumed. */
  legUuid: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallHoldEvent = z.infer<typeof CallHoldEventSchema>;

export const CallParticipantTypeSchema = z.enum([
  'agent',
  'external',
  'caller',
]);
export type CallParticipantType = z.infer<typeof CallParticipantTypeSchema>;

export const CallParticipantStatusEventSchema = z.object({
  conversationUuid: z.string(),
  legUuid: z.string().optional(),
  participantType: CallParticipantTypeSchema,
  participantId: z.string(),
  status: z.string(),
  eventType: z.string(),
  description: z.string(),
  duration: z.number().int().nonnegative().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallParticipantStatusEvent = z.infer<
  typeof CallParticipantStatusEventSchema
>;

export const CallRecordingReadyEventSchema = z.object({
  conversationUuid: z.string(),
  recordingUrl: z.url(),
  duration: z.number().int().nonnegative().optional(),
  context: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallRecordingReadyEvent = z.infer<
  typeof CallRecordingReadyEventSchema
>;

export const CallTranscriptionReadyEventSchema = z.object({
  conversationUuid: z.string(),
  transcript: z.string(),
  recordingUrl: z.url().optional(),
  context: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallTranscriptionReadyEvent = z.infer<
  typeof CallTranscriptionReadyEventSchema
>;

export const CallConversationMigratedEventSchema = z.object({
  previousConversationUuid: z.string(),
  conversationUuid: z.string(),
  legUuid: z.string().optional(),
  timestamp: IsoDateTimeSchema,
});
export type CallConversationMigratedEvent = z.infer<
  typeof CallConversationMigratedEventSchema
>;

// ---------------------------------------------------------------------------
// Commands (API -> call controller)
// ---------------------------------------------------------------------------

export const CallHangupCommandSchema = z.object({
  conversationUuid: z.string(),
  initiatedBy: z.string(),
});
export type CallHangupCommand = z.infer<typeof CallHangupCommandSchema>;

// ---------------------------------------------------------------------------
// Channel -> schema map. Adding a channel without a schema is a type error.
// ---------------------------------------------------------------------------

export const EVENT_SCHEMAS = {
  'call:incoming': CallIncomingEventSchema,
  'call:started': CallStartedEventSchema,
  'call:ended': CallEndedEventSchema,
  'call:missed': CallMissedEventSchema,
  'call:transferred': CallTransferredEventSchema,
  'call:held': CallHoldEventSchema,
  'call:resumed': CallHoldEventSchema,
  'call:participant-status': CallParticipantStatusEventSchema,
  'call:recording-ready': CallRecordingReadyEventSchema,
  'call:transcription-ready': CallTranscriptionReadyEventSchema,
  'call:conversation-migrated': CallConversationMigratedEventSchema,
} as const satisfies Record<EventChannel, z.ZodType>;

export const COMMAND_SCHEMAS = {
  'call:hangup': CallHangupCommandSchema,
} as const satisfies Record<CommandChannel, z.ZodType>;

export const CHANNEL_SCHEMAS = {
  ...EVENT_SCHEMAS,
  ...COMMAND_SCHEMAS,
} as const satisfies Record<Channel, z.ZodType>;

/** What a subscriber receives on a channel, after validation and defaults. */
export type ChannelPayload<C extends Channel> = z.infer<
  (typeof CHANNEL_SCHEMAS)[C]
>;

/** What a publisher must supply for a channel; defaults may be omitted. */
export type ChannelInput<C extends Channel> = z.input<
  (typeof CHANNEL_SCHEMAS)[C]
>;
