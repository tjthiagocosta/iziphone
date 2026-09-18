import { VOICEMAIL_GREETING_MAX_SIZE_BYTES } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import { inspectGreetingFile } from './greeting-file.js';

/** The first bytes of a file of each format, padded like a real file would be. */
const MP3_WITH_ID3 = Buffer.concat([
  Buffer.from('ID3', 'latin1'),
  Buffer.alloc(64),
]);
const MP3_BARE_FRAME = Buffer.concat([
  Buffer.from([0xff, 0xfb, 0x90, 0x00]),
  Buffer.alloc(64),
]);
const WAV = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WAVEfmt ', 'latin1'),
  Buffer.alloc(64),
]);
const AIFF = Buffer.concat([
  Buffer.from('FORM', 'latin1'),
  Buffer.from([0x00, 0x00, 0x00, 0x24]),
  Buffer.from('AIFFCOMM', 'latin1'),
  Buffer.alloc(64),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

describe('inspectGreetingFile', () => {
  test.each([
    ['audio/mpeg', MP3_WITH_ID3, 'mp3'],
    ['audio/mp3', MP3_BARE_FRAME, 'mp3'],
    ['audio/wav', WAV, 'wav'],
    ['audio/x-wav', WAV, 'wav'],
    ['audio/wave', WAV, 'wav'],
    ['audio/vnd.wave', WAV, 'wav'],
    ['audio/aiff', AIFF, 'aiff'],
    ['audio/x-aiff', AIFF, 'aiff'],
  ])('accepts %s whose bytes agree', (contentType, bytes, format) => {
    expect(inspectGreetingFile(contentType, bytes)).toEqual({
      ok: true,
      format,
    });
  });

  test('ignores parameters and case on the declared type', () => {
    expect(
      inspectGreetingFile('Audio/MPEG; charset=binary', MP3_WITH_ID3),
    ).toEqual({ ok: true, format: 'mp3' });
  });

  test.each([
    ['application/octet-stream', MP3_WITH_ID3, 'mp3'],
    ['application/octet-stream', MP3_BARE_FRAME, 'mp3'],
    ['application/octet-stream', WAV, 'wav'],
    ['Application/Octet-Stream; x=y', AIFF, 'aiff'],
  ])(
    'lets the bytes name the format when the type is the generic %s',
    (contentType, bytes, format) => {
      expect(inspectGreetingFile(contentType, bytes)).toEqual({
        ok: true,
        format,
      });
    },
  );

  test('refuses a generic-typed file that opens like none of the formats', () => {
    expect(inspectGreetingFile('application/octet-stream', PNG)).toEqual({
      ok: false,
      rejection: { reason: 'not_audio', declared: null },
    });
  });

  test.each([
    ['audio/ogg', 'a format <Play> does not list'],
    ['audio/x-gsm', 'a <Play> format whose files carry no header to check'],
    ['image/png', 'not audio at all'],
    ['', 'an empty type'],
    [undefined, 'no type'],
  ])('refuses %s (%s) before looking at the bytes', (contentType) => {
    expect(inspectGreetingFile(contentType, WAV)).toEqual({
      ok: false,
      rejection: { reason: 'unsupported_type', contentType },
    });
  });

  test.each([
    ['audio/mpeg', 'mp3', WAV],
    ['audio/mpeg', 'mp3', PNG],
    ['audio/wav', 'wav', MP3_WITH_ID3],
    ['audio/wav', 'wav', AIFF],
    ['audio/aiff', 'aiff', WAV],
    ['audio/aiff', 'aiff', PNG],
  ])(
    'refuses a file declared %s whose bytes are something else',
    (contentType, declared, bytes) => {
      expect(inspectGreetingFile(contentType, bytes)).toEqual({
        ok: false,
        rejection: { reason: 'not_audio', declared },
      });
    },
  );

  test('refuses a sync word whose layer bits are the reserved value', () => {
    const notAFrame = Buffer.concat([
      Buffer.from([0xff, 0xf9, 0x90, 0x00]),
      Buffer.alloc(64),
    ]);

    expect(inspectGreetingFile('audio/mpeg', notAFrame)).toEqual({
      ok: false,
      rejection: { reason: 'not_audio', declared: 'mp3' },
    });
  });

  test('refuses a file shorter than its own header', () => {
    expect(
      inspectGreetingFile('audio/wav', Buffer.from('RIFF', 'latin1')),
    ).toEqual({
      ok: false,
      rejection: { reason: 'not_audio', declared: 'wav' },
    });
  });

  test('refuses an empty body', () => {
    expect(inspectGreetingFile('audio/mpeg', Buffer.alloc(0))).toEqual({
      ok: false,
      rejection: { reason: 'empty' },
    });
  });

  test('refuses a file over the size cap even when its bytes look right', () => {
    const oversized = Buffer.concat([
      MP3_WITH_ID3,
      Buffer.alloc(
        VOICEMAIL_GREETING_MAX_SIZE_BYTES - MP3_WITH_ID3.byteLength + 1,
      ),
    ]);

    expect(inspectGreetingFile('audio/mpeg', oversized)).toEqual({
      ok: false,
      rejection: {
        reason: 'too_large',
        maxBytes: VOICEMAIL_GREETING_MAX_SIZE_BYTES,
      },
    });
  });

  test('accepts a file exactly at the size cap', () => {
    const atCap = Buffer.concat([
      MP3_WITH_ID3,
      Buffer.alloc(VOICEMAIL_GREETING_MAX_SIZE_BYTES - MP3_WITH_ID3.byteLength),
    ]);

    expect(inspectGreetingFile('audio/mpeg', atCap)).toEqual({
      ok: true,
      format: 'mp3',
    });
  });
});
