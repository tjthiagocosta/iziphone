import {
  VOICEMAIL_GREETING_MAX_SIZE_BYTES,
  VOICEMAIL_GREETING_MIME_TYPES,
  VOICEMAIL_GREETING_UNKNOWN_MIME_TYPE,
} from '@repo/dto';

/*
 * Whether an upload may become a department's voicemail greeting. Twilio's
 * `<Play>` fetches the file as it is stored, so only the formats it documents
 * are accepted, and only those whose files open with a header that can be
 * checked: a browser names the type from the file's extension, which says
 * nothing about the bytes, and sometimes names none at all.
 *
 * The size cap is this module's own rule, whoever calls it. The upload route
 * also stops reading an oversized body early; that is the transport refusing
 * to buffer it, not a second copy of the rule.
 */

/** The formats a greeting is stored in, each with the type it is served as. */
export const GREETING_FORMATS = {
  mp3: { contentType: 'audio/mpeg', extension: 'mp3' },
  wav: { contentType: 'audio/wav', extension: 'wav' },
  aiff: { contentType: 'audio/aiff', extension: 'aiff' },
} as const;

export type GreetingFormat = keyof typeof GREETING_FORMATS;

const ALL_FORMATS = Object.keys(GREETING_FORMATS) as GreetingFormat[];

export type GreetingRejection =
  | { reason: 'unsupported_type'; contentType: string | undefined }
  /** The bytes match no accepted format; `declared` is the one the type named, if any. */
  | { reason: 'not_audio'; declared: GreetingFormat | null }
  | { reason: 'empty' }
  | { reason: 'too_large'; maxBytes: number };

export type GreetingInspection =
  | { ok: true; format: GreetingFormat }
  | { ok: false; rejection: GreetingRejection };

const FORMAT_BY_DECLARED_TYPE: Record<
  (typeof VOICEMAIL_GREETING_MIME_TYPES)[number],
  GreetingFormat
> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

export function inspectGreetingFile(
  declaredContentType: string | undefined,
  bytes: Buffer,
): GreetingInspection {
  const declared = formatOfDeclaredType(declaredContentType);

  if (declared === undefined) {
    return {
      ok: false,
      rejection: {
        reason: 'unsupported_type',
        contentType: declaredContentType,
      },
    };
  }

  if (bytes.byteLength === 0) {
    return { ok: false, rejection: { reason: 'empty' } };
  }

  if (bytes.byteLength > VOICEMAIL_GREETING_MAX_SIZE_BYTES) {
    return {
      ok: false,
      rejection: {
        reason: 'too_large',
        maxBytes: VOICEMAIL_GREETING_MAX_SIZE_BYTES,
      },
    };
  }

  const candidates = declared === null ? ALL_FORMATS : [declared];
  const format = candidates.find((candidate) => startsLike(candidate, bytes));

  return format
    ? { ok: true, format }
    : { ok: false, rejection: { reason: 'not_audio', declared } };
}

/**
 * The format the declared type names: `null` when the type is the generic
 * one and the bytes must decide, `undefined` when the type is not accepted.
 */
function formatOfDeclaredType(
  declaredContentType: string | undefined,
): GreetingFormat | null | undefined {
  const mediaType = declaredContentType?.split(';')[0]?.trim().toLowerCase();

  if (mediaType === VOICEMAIL_GREETING_UNKNOWN_MIME_TYPE) {
    return null;
  }

  return mediaType && isAcceptedType(mediaType)
    ? FORMAT_BY_DECLARED_TYPE[mediaType]
    : undefined;
}

function isAcceptedType(
  mediaType: string,
): mediaType is (typeof VOICEMAIL_GREETING_MIME_TYPES)[number] {
  return (VOICEMAIL_GREETING_MIME_TYPES as readonly string[]).includes(
    mediaType,
  );
}

function startsLike(format: GreetingFormat, bytes: Buffer): boolean {
  switch (format) {
    case 'mp3':
      return hasId3Tag(bytes) || hasMpegFrameSync(bytes);
    case 'wav':
      return tagAt(bytes, 0) === 'RIFF' && tagAt(bytes, 8) === 'WAVE';
    case 'aiff':
      return tagAt(bytes, 0) === 'FORM' && tagAt(bytes, 8) === 'AIFF';
  }
}

function hasId3Tag(bytes: Buffer): boolean {
  return tagAt(bytes, 0, 3) === 'ID3';
}

/**
 * An MPEG audio frame opens with eleven set sync bits; the two bits after
 * them name the layer, and `00` is reserved, so it is not a frame either.
 */
function hasMpegFrameSync(bytes: Buffer): boolean {
  const first = bytes[0];
  const second = bytes[1];

  return (
    first === 0xff &&
    second !== undefined &&
    (second & 0xe0) === 0xe0 &&
    (second & 0x06) !== 0x00
  );
}

function tagAt(bytes: Buffer, offset: number, length = 4): string | undefined {
  return bytes.byteLength >= offset + length
    ? bytes.toString('latin1', offset, offset + length)
    : undefined;
}
