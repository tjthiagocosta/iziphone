import {
  type ContactListQuery,
  type ContactListResponse,
  ContactListResponseSchema,
  type MessageConversation,
  type MessageConversationListQuery,
  type MessageConversationListResponse,
  MessageConversationListResponseSchema,
  MessageConversationSchema,
  type MessageListQuery,
  type MessageListResponse,
  MessageListResponseSchema,
  type MessageSendersResponse,
  MessageSendersResponseSchema,
  type SendSms,
  type SendSmsResponse,
  SendSmsResponseSchema,
  type UserDepartmentsResponse,
  UserDepartmentsResponseSchema,
} from '@repo/dto';
import { requestApi, withQuery } from './client';

/* Routes under `/api/user`, open to every signed-in user. */

export function getUserDepartments(): Promise<UserDepartmentsResponse> {
  return requestApi('/api/user/departments', {
    schema: UserDepartmentsResponseSchema,
  });
}

/** The numbers the user may send messages from. */
export function getMessageSenders(): Promise<MessageSendersResponse> {
  return requestApi('/api/user/message-senders', {
    schema: MessageSendersResponseSchema,
  });
}

/** Everyone the caller has a conversation with, alphabetically. */
export function listContacts(
  query: Partial<ContactListQuery> = {},
): Promise<ContactListResponse> {
  return requestApi(withQuery('/api/user/contacts', query), {
    schema: ContactListResponseSchema,
  });
}

export function listMessageConversations(
  query: Partial<MessageConversationListQuery> = {},
): Promise<MessageConversationListResponse> {
  return requestApi(withQuery('/api/user/message-conversations', query), {
    schema: MessageConversationListResponseSchema,
  });
}

export function getMessageConversation(
  conversationId: string,
): Promise<MessageConversation> {
  return requestApi(
    `/api/user/message-conversations/${encodeURIComponent(conversationId)}`,
    { schema: MessageConversationSchema },
  );
}

/** Newest first; pass `beforeMessageId` to page back in time. */
export function getConversationMessages(
  conversationId: string,
  query: Partial<MessageListQuery> = {},
): Promise<MessageListResponse> {
  return requestApi(
    withQuery(
      `/api/user/message-conversations/${encodeURIComponent(conversationId)}/messages`,
      query,
    ),
    { schema: MessageListResponseSchema },
  );
}

export function markMessageConversationRead(
  conversationId: string,
): Promise<void> {
  return requestApi(
    `/api/user/message-conversations/${encodeURIComponent(conversationId)}/read`,
    { method: 'POST' },
  );
}

export function sendSms(input: SendSms): Promise<SendSmsResponse> {
  return requestApi('/api/user/messages', {
    method: 'POST',
    body: input,
    schema: SendSmsResponseSchema,
  });
}
