import type { TwilioCredentials } from '../../config.js';
import type {
  MessagingTransport,
  MessagingTransportInboundEvent,
  MessagingTransportSendMmsInput,
  MessagingTransportSendSmsInput,
  MessagingTransportSendSuccess,
  MessagingTransportStatusEvent,
} from '../transport.js';
import {
  normalizeTwilioInboundEvent,
  normalizeTwilioStatusEvent,
  parseTwilioMessagesCreateResponse,
  parseTwilioMessagesErrorResponse,
  type TwilioMessagesCreateResponse,
  type TwilioMessagesErrorResponse,
} from './messages.schemas.js';

const TWILIO_API_BASE_URL = 'https://api.twilio.com';

export interface TwilioMessagesServiceOptions {
  /** Null when the deployment has no Twilio credentials; sends then fail fast. */
  credentials: TwilioCredentials | null;
  /** Public base URL of this API, where status callbacks are delivered. */
  publicUrl: string;
  fetch?: typeof fetch;
}

/** The provider could not be reached or answered with something unparseable. */
export class TwilioMessagesTransportError extends Error {
  readonly request: Record<string, unknown>;
  readonly responseStatus: number | null;
  readonly responseBody: string | null;
  readonly responseHeaders: Record<string, string>;
  readonly requestId: string | null;
  override readonly cause: unknown;

  constructor(
    message: string,
    options: {
      request: Record<string, unknown>;
      responseStatus?: number | null;
      responseBody?: string | null;
      responseHeaders?: Record<string, string>;
      requestId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'TwilioMessagesTransportError';
    this.request = options.request;
    this.responseStatus = options.responseStatus ?? null;
    this.responseBody = options.responseBody ?? null;
    this.responseHeaders = options.responseHeaders ?? {};
    this.requestId = options.requestId ?? null;
    this.cause = options.cause ?? null;
  }
}

/** The provider answered with a structured error; `retriable` tells the two apart. */
export class TwilioMessagesApiError extends Error {
  readonly request: Record<string, unknown>;
  readonly responseStatus: number;
  readonly responseBody: string | null;
  readonly responseHeaders: Record<string, string>;
  readonly requestId: string | null;
  readonly errorCode: string | null;
  readonly errorType: string | null;
  readonly errorDetail: string;
  readonly retriable: boolean;

  constructor(
    message: string,
    options: {
      request: Record<string, unknown>;
      responseStatus: number;
      responseBody: string | null;
      responseHeaders: Record<string, string>;
      requestId: string | null;
      error: TwilioMessagesErrorResponse;
    },
  ) {
    super(message);
    this.name = 'TwilioMessagesApiError';
    this.request = options.request;
    this.responseStatus = options.responseStatus;
    this.responseBody = options.responseBody;
    this.responseHeaders = options.responseHeaders;
    this.requestId = options.requestId;
    this.errorCode =
      typeof options.error.code === 'number'
        ? String(options.error.code)
        : null;
    this.errorType = options.error.more_info ?? null;
    this.errorDetail = options.error.message;
    this.retriable =
      options.responseStatus === 429 || options.responseStatus >= 500;
  }
}

export class TwilioMessagesService implements MessagingTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: TwilioCredentials | null;
  private readonly statusCallbackUrl: string;

  constructor(options: TwilioMessagesServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.credentials = options.credentials;
    this.statusCallbackUrl = `${options.publicUrl}/webhooks/twilio/messages/status`;
  }

  async sendSms(
    input: MessagingTransportSendSmsInput,
  ): Promise<MessagingTransportSendSuccess> {
    return this.sendRequest(
      {
        To: input.to,
        From: input.from,
        Body: input.text,
        StatusCallback: this.statusCallbackUrl,
      },
      input.clientReference,
      'SMS',
    );
  }

  async sendMms(
    input: MessagingTransportSendMmsInput,
  ): Promise<MessagingTransportSendSuccess> {
    return this.sendRequest(
      {
        To: input.to,
        From: input.from,
        Body: input.text ?? undefined,
        MediaUrl: [input.mediaUrl],
        StatusCallback: this.statusCallbackUrl,
      },
      input.clientReference,
      'MMS',
    );
  }

  normalizeInboundEvent(payload: unknown): MessagingTransportInboundEvent {
    return normalizeTwilioInboundEvent(payload);
  }

  normalizeStatusEvent(payload: unknown): MessagingTransportStatusEvent {
    return normalizeTwilioStatusEvent(payload);
  }

  private async sendRequest(
    request: Record<string, string | string[] | undefined>,
    clientReference: string,
    channel: 'SMS' | 'MMS',
  ): Promise<MessagingTransportSendSuccess> {
    if (!this.credentials) {
      throw new TwilioMessagesTransportError(
        'Twilio credentials are not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)',
        { request },
      );
    }

    const { accountSid, authToken } = this.credentials;
    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let responseHeaders: Record<string, string> = {};
    let requestId: string | null = null;

    try {
      const response = await this.fetchImpl(
        `${TWILIO_API_BASE_URL}/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: basicAuthHeader(accountSid, authToken),
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: buildFormBody(request).toString(),
        },
      );

      responseStatus = response.status;
      responseHeaders = Object.fromEntries(response.headers.entries());
      requestId =
        responseHeaders['twilio-request-id'] ??
        responseHeaders['x-request-id'] ??
        null;
      responseBody = await response.text();

      if (!response.ok) {
        const parsedError = this.parseErrorResponse(request, responseBody);
        throw new TwilioMessagesApiError(parsedError.message, {
          request,
          responseStatus: response.status,
          responseBody,
          responseHeaders,
          requestId,
          error: parsedError,
        });
      }

      let parsed: TwilioMessagesCreateResponse;

      try {
        parsed = parseTwilioMessagesCreateResponse(JSON.parse(responseBody));
      } catch (error) {
        throw new TwilioMessagesTransportError(
          'Twilio Messages API returned an unexpected response payload',
          {
            request,
            responseStatus,
            responseBody,
            responseHeaders,
            requestId,
            cause: error,
          },
        );
      }

      return {
        outcome: 'accepted',
        provider: 'TWILIO',
        channel,
        providerMessageId: parsed.sid,
        clientReference,
        requestId,
        request,
        response: parsed,
        responseHeaders,
      };
    } catch (error) {
      if (
        error instanceof TwilioMessagesApiError ||
        error instanceof TwilioMessagesTransportError
      ) {
        throw error;
      }

      throw new TwilioMessagesTransportError(
        error instanceof Error
          ? error.message
          : 'Twilio Messages request failed',
        {
          request,
          responseStatus,
          responseBody,
          responseHeaders,
          requestId,
          cause: error,
        },
      );
    }
  }

  private parseErrorResponse(
    request: Record<string, unknown>,
    responseBody: string | null,
  ) {
    if (!responseBody) {
      throw new TwilioMessagesTransportError(
        'Twilio Messages API returned an empty error response',
        { request, responseBody },
      );
    }

    try {
      return parseTwilioMessagesErrorResponse(JSON.parse(responseBody));
    } catch (error) {
      throw new TwilioMessagesTransportError(
        'Twilio Messages API returned invalid JSON',
        {
          request,
          responseBody,
          cause: error,
        },
      );
    }
  }
}

function buildFormBody(request: Record<string, string | string[] | undefined>) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(request)) {
    if (value === undefined) {
      continue;
    }

    for (const entry of Array.isArray(value) ? value : [value]) {
      body.append(key, entry);
    }
  }

  return body;
}

function basicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
