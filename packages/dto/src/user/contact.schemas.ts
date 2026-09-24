import { z } from 'zod';
import {
  PaginationMetaSchema,
  PaginationQuerySchema,
} from '../common/pagination.js';
import { IsoDateTimeSchema } from '../common/primitives.js';
import {
  MessageConversationSourcePhoneNumberSchema,
  MessageOwnerSchema,
} from './messaging.schemas.js';

export const CONTACT_LIST_MAX_LIMIT = 100;

export const ContactListQuerySchema = PaginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(CONTACT_LIST_MAX_LIMIT).default(50),
  /** Matched against the name and against the digits of the number. */
  search: z.string().trim().min(1).optional(),
});

/**
 * One thread with this contact. A contact has one per line they were reached
 * on and owner of that line, and only the ones the caller may see are listed —
 * which is also the answer to "which of our numbers do I know them on?". A
 * line that changed hands can list twice, once per owner, for somebody who
 * can read both owners' threads.
 */
export const ContactConversationSchema = z.object({
  id: z.string(),
  sourcePhoneNumber: MessageConversationSourcePhoneNumberSchema,
  /** Whose thread it is, as on the conversation itself. */
  owner: MessageOwnerSchema.nullable(),
  lastMessageAt: IsoDateTimeSchema.nullable(),
  unreadCount: z.number().int().nonnegative(),
});

export const ContactSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  phoneNumber: z.string(),
  conversations: z.array(ContactConversationSchema),
});

export const ContactListResponseSchema = PaginationMetaSchema.extend({
  contacts: z.array(ContactSchema),
});

export type ContactListQuery = z.infer<typeof ContactListQuerySchema>;
export type ContactConversation = z.infer<typeof ContactConversationSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type ContactListResponse = z.infer<typeof ContactListResponseSchema>;
