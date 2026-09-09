import type {
  MessageConversation,
  MessageConversationListQuery,
  MessageConversationListResponse,
  MessageListQuery,
  MessageListResponse,
  MessageSendersResponse,
  SendSms,
  SendSmsResponse,
  UserDepartmentsResponse,
} from '@repo/dto';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly data?: unknown;

  constructor(status: number, message: string, code?: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {};

  // Copy existing headers
  if (options?.headers) {
    const existingHeaders = new Headers(options.headers);
    existingHeaders.forEach((value, key) => {
      headers[key] = value;
    });
  }

  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body.message || `API error: ${response.status}`,
      body.error,
      body,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

/**
 * Get departments for the current authenticated user
 */
export async function getUserDepartments(): Promise<UserDepartmentsResponse> {
  return fetchApi('/api/user/departments');
}

/**
 * Get phone numbers the current user is allowed to send SMS from
 */
export async function getMessageSenders(): Promise<MessageSendersResponse> {
  return fetchApi('/api/user/message-senders');
}

/**
 * List message conversations for the current user
 */
export async function listMessageConversations(
  query?: Partial<MessageConversationListQuery>,
): Promise<MessageConversationListResponse> {
  const params = new URLSearchParams();

  if (query?.page) params.set('page', String(query.page));
  if (query?.limit) params.set('limit', String(query.limit));
  if (query?.search) params.set('search', query.search);
  if (query?.unreadOnly !== undefined)
    params.set('unreadOnly', String(query.unreadOnly));
  if (query?.sourcePhoneNumberId)
    params.set('sourcePhoneNumberId', query.sourcePhoneNumberId);

  const qs = params.toString();
  return fetchApi(`/api/user/message-conversations${qs ? `?${qs}` : ''}`);
}

/**
 * Get a single message conversation by ID
 */
export async function getMessageConversation(
  conversationId: string,
): Promise<MessageConversation> {
  return fetchApi(`/api/user/message-conversations/${conversationId}`);
}

/**
 * Get messages for a conversation (cursor-based pagination)
 */
export async function getConversationMessages(
  conversationId: string,
  query?: Partial<MessageListQuery>,
): Promise<MessageListResponse> {
  const params = new URLSearchParams();

  if (query?.limit) params.set('limit', String(query.limit));
  if (query?.beforeMessageId)
    params.set('beforeMessageId', query.beforeMessageId);

  const qs = params.toString();
  return fetchApi(
    `/api/user/message-conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Mark a message conversation as read
 */
export async function markMessageConversationRead(
  conversationId: string,
): Promise<void> {
  return fetchApi(`/api/user/message-conversations/${conversationId}/read`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Send an SMS message
 */
export async function sendSms(input: SendSms): Promise<SendSmsResponse> {
  return fetchApi('/api/user/messages', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
