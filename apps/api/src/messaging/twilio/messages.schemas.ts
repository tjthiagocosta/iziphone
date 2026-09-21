import { normalizePhoneNumber, toMessageAddress } from '@repo/dto';
import { z } from 'zod';
import type {
  MessagingTransportInboundEvent,
  MessagingTransportInboundMedia,
  MessagingTransportStatusEvent,
} from '../transport.js';

const RawPayloadSchema = z.record(z.string(), z.unknown());

const TwilioMessagesCreateResponseSchema = z.looseObject({
  sid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/),
  status: z.string().optional(),
  date_created: z.string().nullable().optional(),
  error_code: z.union([z.string(), z.number()]).nullable().optional(),
  error_message: z.string().nullable().optional(),
});

const TwilioMessagesErrorResponseSchema = z.looseObject({
  code: z.number().int().optional(),
  message: z.string().min(1),
  more_info: z.url().optional(),
  status: z.number().int().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/*
 * Twilio posts webhooks as form data. A repeated key arrives as an array from
 * the form-body parser; only the first value carries meaning.
 */
const FormValueSchema = z
  .union([z.string(), z.array(z.string()).min(1)])
  .transform((value) => (Array.isArray(value) ? (value[0] ?? '') : value));

const OptionalFormValueSchema = FormValueSchema.optional().transform(
  (value) => value?.trim() || undefined,
);

const E164FormValueSchema = FormValueSchema.transform((value, ctx) => {
  const normalized = normalizePhoneNumber(value);
  if (normalized === null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid phone number' });
    return z.NEVER;
  }
  return normalized;
});

/**
 * The other party on an inbound message. Twilio puts a phone number, a short
 * code or a sender id in there; a number is normalised to E.164 and the rest is
 * kept exactly as sent. Refusing the ones that are not numbers would answer the
 * webhook 400, and Twilio does not retry a 4xx, so the message would be lost.
 */
const MessageAddressFormValueSchema = FormValueSchema.transform(
  (value, ctx) => {
    const address = toMessageAddress(value);
    if (address === null) {
      ctx.addIssue({ code: 'custom', message: 'Invalid message sender' });
      return z.NEVER;
    }
    return address.value;
  },
);

/** Phone fields on a status callback are informational; keep whatever was sent. */
const LenientPhoneFormValueSchema = OptionalFormValueSchema.transform(
  (value) => (value ? (normalizePhoneNumber(value) ?? value) : ''),
);

const TwilioInboundPayloadSchema = z.looseObject({
  MessageSid: OptionalFormValueSchema,
  SmsSid: OptionalFormValueSchema,
  From: MessageAddressFormValueSchema,
  /** Our own number, so this one really has to be a number we recognise. */
  To: E164FormValueSchema,
  Body: OptionalFormValueSchema,
  DateCreated: OptionalFormValueSchema,
  OptOutType: OptionalFormValueSchema,
  NumMedia: OptionalFormValueSchema,
});

const TwilioStatusPayloadSchema = z.looseObject({
  MessageSid: OptionalFormValueSchema,
  SmsSid: OptionalFormValueSchema,
  MessageStatus: OptionalFormValueSchema,
  SmsStatus: OptionalFormValueSchema,
  From: LenientPhoneFormValueSchema,
  To: LenientPhoneFormValueSchema,
  NumMedia: OptionalFormValueSchema,
  DateUpdated: OptionalFormValueSchema,
  DateSent: OptionalFormValueSchema,
  DateCreated: OptionalFormValueSchema,
  ClientReference: OptionalFormValueSchema,
  ErrorCode: OptionalFormValueSchema,
  ErrorMessage: OptionalFormValueSchema,
  ChannelStatusMessage: OptionalFormValueSchema,
});

export type TwilioMessagesCreateResponse = z.infer<
  typeof TwilioMessagesCreateResponseSchema
>;

export type TwilioMessagesErrorResponse = z.infer<
  typeof TwilioMessagesErrorResponseSchema
>;

export function parseTwilioMessagesCreateResponse(payload: unknown) {
  return TwilioMessagesCreateResponseSchema.parse(payload);
}

export function parseTwilioMessagesErrorResponse(payload: unknown) {
  return TwilioMessagesErrorResponseSchema.parse(payload);
}

export function normalizeTwilioInboundEvent(
  payload: unknown,
): MessagingTransportInboundEvent {
  const rawPayload = RawPayloadSchema.parse(payload);
  const parsed = TwilioInboundPayloadSchema.parse(rawPayload);
  const media = extractInboundMedia(rawPayload, parsed.NumMedia);

  return {
    provider: 'TWILIO',
    channel: media.length > 0 ? 'MMS' : 'SMS',
    providerMessageId: requireMessageSid(parsed),
    providerTimestamp: toIsoString(parsed.DateCreated),
    from: parsed.From,
    to: parsed.To,
    body: parsed.Body ?? null,
    keyword: parsed.OptOutType?.toUpperCase() ?? null,
    media,
    rawPayload,
  };
}

export function normalizeTwilioStatusEvent(
  payload: unknown,
): MessagingTransportStatusEvent {
  const rawPayload = RawPayloadSchema.parse(payload);
  const parsed = TwilioStatusPayloadSchema.parse(rawPayload);
  const rawStatus = parsed.MessageStatus ?? parsed.SmsStatus;

  if (!rawStatus) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['MessageStatus'],
        message: 'Missing required Twilio webhook parameter: MessageStatus',
        input: payload,
      },
    ]);
  }

  return {
    provider: 'TWILIO',
    channel: parseCount(parsed.NumMedia) > 0 ? 'MMS' : 'SMS',
    providerMessageId: requireMessageSid(parsed),
    providerTimestamp: toIsoString(
      parsed.DateUpdated ?? parsed.DateSent ?? parsed.DateCreated,
    ),
    from: parsed.From,
    to: parsed.To,
    providerStatus: mapTwilioStatus(rawStatus.toLowerCase()),
    clientReference: parsed.ClientReference ?? null,
    errorCode: parsed.ErrorCode ?? null,
    errorText: parsed.ErrorMessage ?? null,
    errorType: parsed.ChannelStatusMessage ?? null,
    rawPayload,
  };
}

function requireMessageSid(parsed: {
  MessageSid?: string | undefined;
  SmsSid?: string | undefined;
}): string {
  const sid = parsed.MessageSid ?? parsed.SmsSid;

  if (!sid) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['MessageSid'],
        message: 'Missing required Twilio webhook parameter: MessageSid',
        input: parsed,
      },
    ]);
  }

  return sid;
}

function extractInboundMedia(
  payload: Record<string, unknown>,
  numMedia: string | undefined,
): MessagingTransportInboundMedia[] {
  const total = parseCount(numMedia);
  const attachments: MessagingTransportInboundMedia[] = [];

  for (let index = 0; index < total; index += 1) {
    const url = readFormValue(payload[`MediaUrl${index}`]);
    if (!url) {
      continue;
    }

    attachments.push({
      url,
      mimeType: readFormValue(payload[`MediaContentType${index}`]) ?? null,
      fileName: fileNameFromUrl(url),
    });
  }

  return attachments;
}

function readFormValue(value: unknown): string | undefined {
  const parsed = OptionalFormValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function mapTwilioStatus(rawStatus: string) {
  switch (rawStatus) {
    case 'delivered':
    case 'read':
      return 'delivered' as const;
    case 'undelivered':
    case 'failed':
      return 'undeliverable' as const;
    case 'canceled':
    case 'cancelled':
      return 'rejected' as const;
    default:
      return 'submitted' as const;
  }
}

function parseCount(value: string | undefined) {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Twilio omits or malforms timestamps on some callbacks; receipt time is the fallback. */
function toIsoString(value: string | undefined) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
}

function fileNameFromUrl(url: string) {
  try {
    const pathName = new URL(url).pathname;
    return pathName.split('/').filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}
