import { VOICEMAIL_GREETING_MAX_SIZE_BYTES } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import { checkGreetingFile, GREETING_FILE_ACCEPT } from './greeting-file';

describe('checkGreetingFile', () => {
  test.each([
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/aiff',
  ])('accepts a %s file of a sensible size', (type) => {
    expect(checkGreetingFile({ type, size: 240_000 })).toEqual({ ok: true });
  });

  test('accepts a type however the browser cased it', () => {
    expect(checkGreetingFile({ type: 'Audio/MPEG', size: 1 })).toEqual({
      ok: true,
    });
  });

  test.each(['', 'application/octet-stream'])(
    'leaves a file typed %j to the API, which reads its bytes',
    (type) => {
      expect(checkGreetingFile({ type, size: 240_000 })).toEqual({ ok: true });
    },
  );

  test.each(['audio/ogg', 'image/png', 'text/plain'])(
    'refuses a %s file by name before anything is sent',
    (type) => {
      expect(checkGreetingFile({ type, size: 240_000 })).toEqual({
        ok: false,
        message: 'Choose an MP3, WAV or AIFF file',
      });
    },
  );

  test('refuses an empty file', () => {
    expect(checkGreetingFile({ type: 'audio/mpeg', size: 0 })).toEqual({
      ok: false,
      message: 'The file is empty',
    });
  });

  test('refuses a file over the cap and names the cap', () => {
    expect(
      checkGreetingFile({
        type: 'audio/mpeg',
        size: VOICEMAIL_GREETING_MAX_SIZE_BYTES + 1,
      }),
    ).toEqual({ ok: false, message: 'The file is larger than 5 MB' });
    expect(
      checkGreetingFile({
        type: 'audio/mpeg',
        size: VOICEMAIL_GREETING_MAX_SIZE_BYTES,
      }),
    ).toEqual({ ok: true });
  });
});

describe('GREETING_FILE_ACCEPT', () => {
  test('offers the accepted types and their extensions to the file picker', () => {
    const accept = GREETING_FILE_ACCEPT.split(',');

    expect(accept).toContain('audio/mpeg');
    expect(accept).toContain('audio/wav');
    expect(accept).toContain('audio/aiff');
    expect(accept).toEqual(expect.arrayContaining(['.mp3', '.wav', '.aiff']));
  });
});
