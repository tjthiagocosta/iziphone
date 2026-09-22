import { z } from 'zod';
import {
  MessageChannelSchema,
  MessageDirectionSchema,
  MessageStatusSchema,
  OwnerTypeSchema,
} from '../common/domain.js';
import {
  PaginationMetaSchema,
  PaginationQuerySchema,
} from '../common/pagination.js';
import {
  EntityIdSchema,
  IsoDateTimeSchema,
  PhoneNumberInputSchema,
  QueryBooleanSchema,
} from '../common/primitives.js';

// ---------------------------------------------------------------------------
// Limits (provider constraints surfaced to clients)
// ---------------------------------------------------------------------------

/** Longest body the provider accepts for a single (segmented) SMS. */
export const SMS_BODY_MAX_LENGTH = 1600;
export const MMS_CAPTION_MAX_LENGTH = 300;
export const MMS_MAX_ATTACHMENTS = 1;
export const MESSAGE_UPLOAD_MAX_SIZE_BYTES = 600 * 1024;
export const MESSAGE_UPLOAD_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
] as const;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH);
const MessageMimeTypeSchema = z.enum(MESSAGE_UPLOAD_ALLOWED_MIME_TYPES);

// ---------------------------------------------------------------------------
// Senders and conversations
// ---------------------------------------------------------------------------

export const MessageOwnerSchema = z.object({
  type: OwnerTypeSchema,
  id: z.string(),
  name: z.string(),
});

/** A number the current user may send from. */
export const MessageSenderSchema = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  label: z.string().nullable(),
  ownerType: OwnerTypeSchema,
  ownerId: z.string(),
  ownerName: z.string(),
  isPrimary: z.boolean(),
  smsEnabled: z.boolean(),
  mmsEnabled: z.boolean(),
});

export const MessageSendersResponseSchema = z.object({
  senders: z.array(MessageSenderSchema),
});

export const MessageConversationContactSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  phoneNumber: z.string(),
});

export const MessageConversationSourcePhoneNumberSchema = z.object({
  id: z.string(),
  phoneNumber: z.string(),
  label: z.string().nullable(),
});

export const MessageConversationListQuerySchema = PaginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().min(1).optional(),
  unreadOnly: QueryBooleanSchema.optional(),
  sourcePhoneNumberId: EntityIdSchema.optional(),
});

export const MessageConversationSchema = z.object({
  id: z.string(),
  contact: MessageConversationContactSchema,
  sourcePhoneNumber: MessageConversationSourcePhoneNumberSchema,
  owner: MessageOwnerSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
  lastReadAt: IsoDateTimeSchema.nullable(),
  lastMessageAt: IsoDateTimeSchema.nullable(),
  lastMessagePreview: z.string().nullable(),
  lastMessageDirection: MessageDirectionSchema.nullable(),
  lastMessageStatus: MessageStatusSchema.nullable(),
  /** The contact opted out (STOP); outbound sends are refused. */
  isSuppressed: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const MessageConversationListItemSchema = MessageConversationSchema;

/**
 * How many conversations in everything the reader can see hold messages they
 * have not read. Not per line or per tab: it is what the browser tab shows
 * while the app is in the background, so it has to count the same whichever
 * view is open.
 */
export const MessageUnreadSummarySchema = z.object({
  unreadConversations: z.number().int().nonnegative(),
});

export const MessageConversationListResponseSchema =
  PaginationMetaSchema.extend({
    conversations: z.array(MessageConversationSchema),
  });

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const MessageMediaSchema = z.object({
  id: z.string(),
  storageUrl: z.url(),
  originalUrl: z.url().nullable(),
  mimeType: z.string(),
  fileName: z.string().nullable(),
  sizeBytes: z.number().int().positive().nullable(),
  createdAt: IsoDateTimeSchema,
});

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  direction: MessageDirectionSchema,
  channel: MessageChannelSchema,
  status: MessageStatusSchema,
  body: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
  sentAt: IsoDateTimeSchema.nullable(),
  deliveredAt: IsoDateTimeSchema.nullable(),
  failedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  attachments: z.array(MessageMediaSchema),
});

export const MessageListQuerySchema = z.object({
  /** Cursor: return messages older than this one. */
  beforeMessageId: EntityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MessageListResponseSchema = z.object({
  messages: z.array(MessageSchema),
  hasMore: z.boolean(),
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** A send targets an existing conversation or a new destination, never both. */
function requireConversationOrDestination(
  value: { conversationId?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (Boolean(value.conversationId) === Boolean(value.to)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Provide exactly one of conversationId or to',
      path: ['conversationId'],
    });
  }
}

const SendTargetShape = {
  fromPhoneNumberId: EntityIdSchema,
  conversationId: EntityIdSchema.optional(),
  to: PhoneNumberInputSchema.optional(),
};

export const SendSmsSchema = z
  .object({
    ...SendTargetShape,
    body: z.string().trim().min(1).max(SMS_BODY_MAX_LENGTH),
    idempotencyKey: IdempotencyKeySchema,
    attachments: z
      .never({
        error:
          'Attachments are not supported for SMS sends; use the MMS endpoint',
      })
      .optional(),
  })
  .superRefine(requireConversationOrDestination);

export const SendSmsResponseSchema = z.object({
  conversationId: z.string(),
  message: MessageSchema,
  /** True when the idempotency key matched an earlier send. */
  deduplicated: z.boolean(),
});

export const MessagePreparedMediaSchema = z.object({
  id: z.string(),
  publicUrl: z.url(),
  mimeType: MessageMimeTypeSchema,
  fileName: z.string(),
  sizeBytes: z.number().int().positive().max(MESSAGE_UPLOAD_MAX_SIZE_BYTES),
  expiresAt: IsoDateTimeSchema,
});

export const RequestMessageMediaUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: MessageMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(MESSAGE_UPLOAD_MAX_SIZE_BYTES),
});

export const MessageMediaUploadSlotResponseSchema = z.object({
  preparedMedia: MessagePreparedMediaSchema,
  uploadUrl: z.url(),
  uploadMethod: z.literal('PUT'),
  maxSizeBytes: z.literal(MESSAGE_UPLOAD_MAX_SIZE_BYTES),
  allowedMimeTypes: z.array(MessageMimeTypeSchema),
});

/** The upload completion and mark-read endpoints take no body. */
export const EmptyBodySchema = z.object({}).optional();
export const CompleteMessageMediaUploadSchema = EmptyBodySchema;
export const MarkMessageConversationReadSchema = EmptyBodySchema;

export const SendMmsSchema = z
  .object({
    ...SendTargetShape,
    body: z.string().trim().max(MMS_CAPTION_MAX_LENGTH).optional(),
    attachmentIds: z.array(EntityIdSchema).min(1).max(MMS_MAX_ATTACHMENTS),
    idempotencyKey: IdempotencyKeySchema,
  })
  .superRefine(requireConversationOrDestination);

export const SendMmsResponseSchema = SendSmsResponseSchema;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageOwner = z.infer<typeof MessageOwnerSchema>;
export type MessageSender = z.infer<typeof MessageSenderSchema>;
export type MessageSendersResponse = z.infer<
  typeof MessageSendersResponseSchema
>;
export type MessageConversationContact = z.infer<
  typeof MessageConversationContactSchema
>;
export type MessageConversationSourcePhoneNumber = z.infer<
  typeof MessageConversationSourcePhoneNumberSchema
>;
export type MessageConversationListQuery = z.infer<
  typeof MessageConversationListQuerySchema
>;
export type MessageConversation = z.infer<typeof MessageConversationSchema>;
export type MessageConversationListItem = MessageConversation;
export type MessageConversationListResponse = z.infer<
  typeof MessageConversationListResponseSchema
>;
export type MessageUnreadSummary = z.infer<typeof MessageUnreadSummarySchema>;
export type MessageMedia = z.infer<typeof MessageMediaSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;
export type MessageListResponse = z.infer<typeof MessageListResponseSchema>;
export type SendSms = z.infer<typeof SendSmsSchema>;
export type SendSmsResponse = z.infer<typeof SendSmsResponseSchema>;
export type MessagePreparedMedia = z.infer<typeof MessagePreparedMediaSchema>;
export type RequestMessageMediaUpload = z.infer<
  typeof RequestMessageMediaUploadSchema
>;
export type MessageMediaUploadSlotResponse = z.infer<
  typeof MessageMediaUploadSlotResponseSchema
>;
export type CompleteMessageMediaUpload = z.infer<
  typeof CompleteMessageMediaUploadSchema
>;
export type SendMms = z.infer<typeof SendMmsSchema>;
export type SendMmsResponse = z.infer<typeof SendMmsResponseSchema>;
export type MarkMessageConversationRead = z.infer<
  typeof MarkMessageConversationReadSchema
>;
