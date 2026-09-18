import {
  VOICEMAIL_GREETING_MAX_SIZE_BYTES,
  VOICEMAIL_GREETING_MIME_TYPES,
  VOICEMAIL_GREETING_UNKNOWN_MIME_TYPE,
} from '@repo/dto';

/*
 * Whether a file an admin picked can be sent as a department's voicemail
 * greeting. The API is the judge (it also reads the bytes); this spares a
 * round trip for the two things the browser already knows: the type it gave
 * the file and its size. A file the browser gave no type to (common for
 * `.aiff` outside macOS) is left to the API.
 */

export type GreetingFileCheck = { ok: true } | { ok: false; message: string };

/** What the file picker is told to offer. */
export const GREETING_FILE_ACCEPT = [
  ...VOICEMAIL_GREETING_MIME_TYPES,
  '.mp3',
  '.wav',
  '.aiff',
  '.aif',
].join(',');

export const GREETING_MAX_SIZE_LABEL = `${Math.floor(
  VOICEMAIL_GREETING_MAX_SIZE_BYTES / (1024 * 1024),
)} MB`;

export function checkGreetingFile(file: {
  type: string;
  size: number;
}): GreetingFileCheck {
  const type = file.type.toLowerCase();

  if (
    type !== '' &&
    type !== VOICEMAIL_GREETING_UNKNOWN_MIME_TYPE &&
    !(VOICEMAIL_GREETING_MIME_TYPES as readonly string[]).includes(type)
  ) {
    return { ok: false, message: 'Choose an MP3, WAV or AIFF file' };
  }

  if (file.size === 0) {
    return { ok: false, message: 'The file is empty' };
  }

  if (file.size > VOICEMAIL_GREETING_MAX_SIZE_BYTES) {
    return {
      ok: false,
      message: `The file is larger than ${GREETING_MAX_SIZE_LABEL}`,
    };
  }

  return { ok: true };
}
