export type MessagingTransportProvider = 'TWILIO';
export type MessagingTransportChannel = 'SMS' | 'MMS';
export type MessagingTransportStatus =
  | 'submitted'
  | 'delivered'
  | 'rejected'
  | 'undeliverable';

export interface MessagingTransportSendSmsInput {
  from: string;
  to: string;
  text: string;
  clientReference: string;
}

export interface MessagingTransportSendMmsInput {
  from: string;
  to: string;
  text: string | null;
  clientReference: string;
  mediaUrl: string;
  mediaType: string;
}

export interface MessagingTransportSendSuccess {
  outcome: 'accepted';
  provider: MessagingTransportProvider;
  channel: MessagingTransportChannel;
  providerMessageId: string;
  clientReference: string | null;
  requestId: string | null;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  responseHeaders: Record<string, string>;
}

export interface MessagingTransportInboundMedia {
  url: string;
  mimeType: string | null;
  fileName: string | null;
}

export interface MessagingTransportInboundEvent {
  provider: MessagingTransportProvider;
  channel: MessagingTransportChannel;
  providerMessageId: string;
  providerTimestamp: string;
  from: string;
  to: string;
  body: string | null;
  /** Opt-out keyword the provider recognised (upper-cased), if any. */
  keyword: string | null;
  media: MessagingTransportInboundMedia[];
  rawPayload: Record<string, unknown>;
}

export interface MessagingTransportStatusEvent {
  provider: MessagingTransportProvider;
  channel: MessagingTransportChannel;
  providerMessageId: string;
  providerTimestamp: string;
  from: string;
  to: string;
  providerStatus: MessagingTransportStatus;
  clientReference: string | null;
  errorCode: string | null;
  errorText: string | null;
  errorType: string | null;
  rawPayload: Record<string, unknown>;
}

export interface MessagingTransport {
  sendSms(
    input: MessagingTransportSendSmsInput,
  ): Promise<MessagingTransportSendSuccess>;
  sendMms(
    input: MessagingTransportSendMmsInput,
  ): Promise<MessagingTransportSendSuccess>;
  normalizeInboundEvent(payload: unknown): MessagingTransportInboundEvent;
  normalizeStatusEvent(payload: unknown): MessagingTransportStatusEvent;
}
