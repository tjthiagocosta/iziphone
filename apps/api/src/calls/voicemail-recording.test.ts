import { describe, expect, test } from 'vitest';
import {
  twilioRecordingMediaUrl,
  voicemailRecordingUrl,
} from './voicemail-recording.js';

const accountSid = 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const recording = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;

describe('voicemailRecordingUrl', () => {
  test('reads the URL from the entry the recording wrote', () => {
    expect(
      voicemailRecordingUrl([
        {
          metadata: {
            recordingUrl: recording,
            duration: 18,
            context: 'voicemail',
          },
        },
      ]),
    ).toBe(recording);
  });

  test('skips a transcription entry that does not name the recording', () => {
    expect(
      voicemailRecordingUrl([
        { metadata: { context: 'voicemail' } },
        { metadata: { recordingUrl: recording, duration: 18 } },
      ]),
    ).toBe(recording);
  });

  test('takes the newest entry when several name a recording', () => {
    const earlier = recording.replace('REb', 'REc');

    expect(
      voicemailRecordingUrl([
        { metadata: { recordingUrl: recording } },
        { metadata: { recordingUrl: earlier } },
      ]),
    ).toBe(recording);
  });

  test.each([
    { name: 'no entries', entries: [] },
    { name: 'an entry without metadata', entries: [{ metadata: null }] },
    { name: 'metadata that is not an object', entries: [{ metadata: 'x' }] },
    {
      name: 'a recording URL that is not a string',
      entries: [{ metadata: { recordingUrl: 42 } }],
    },
  ])('finds nothing in $name', ({ entries }) => {
    expect(voicemailRecordingUrl(entries)).toBeNull();
  });
});

describe('twilioRecordingMediaUrl', () => {
  test('asks for the MP3 of the recording Twilio named', () => {
    expect(twilioRecordingMediaUrl(recording, accountSid)).toBe(
      `${recording}.mp3`,
    );
  });

  test('reads an account SID the same in either case', () => {
    expect(
      twilioRecordingMediaUrl(
        recording.replace(accountSid, 'ACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        accountSid,
      ),
    ).toBe(`${recording}.mp3`);
  });

  test.each([
    { name: 'a WAV extension', stored: `${recording}.wav` },
    { name: 'an MP3 extension', stored: `${recording}.mp3` },
    { name: 'a query string', stored: `${recording}?RequestedChannels=2` },
    { name: 'a fragment', stored: `${recording}#t=10` },
  ])('keeps only the recording SID of a URL with $name', ({ stored }) => {
    expect(twilioRecordingMediaUrl(stored, accountSid)).toBe(
      `${recording}.mp3`,
    );
  });

  test.each([
    { name: 'plain http', stored: recording.replace('https:', 'http:') },
    {
      name: 'another host',
      stored: recording.replace('api.twilio.com', 'recordings.example.com'),
    },
    {
      name: 'a host that only starts like Twilio',
      stored: recording.replace('api.twilio.com', 'api.twilio.com.example.com'),
    },
    {
      name: 'a subdomain of the API host',
      stored: recording.replace('api.twilio.com', 'evil.api.twilio.com'),
    },
    {
      name: 'Twilio as the user name of another host',
      stored: recording.replace('api.twilio.com', 'api.twilio.com@example.com'),
    },
    {
      name: 'credentials of its own',
      stored: recording.replace('https://', 'https://user:secret@'),
    },
    {
      name: 'another port',
      stored: recording.replace('api.twilio.com', 'api.twilio.com:8443'),
    },
    {
      // A parent account's credentials would be honoured for a subaccount's.
      name: 'a recording of another account',
      stored: recording.replace(
        accountSid,
        'ACcccccccccccccccccccccccccccccccc',
      ),
    },
    {
      name: 'another Twilio resource',
      stored: recording.replace('/Recordings/RE', '/Messages/MM'),
    },
    {
      name: 'a path below the recording',
      stored: `${recording}/Transcriptions`,
    },
    { name: 'a malformed recording SID', stored: recording.slice(0, -1) },
    { name: 'something that is not a URL', stored: 'not a url' },
    { name: 'an empty value', stored: '' },
  ])('refuses $name', ({ stored }) => {
    expect(twilioRecordingMediaUrl(stored, accountSid)).toBeNull();
  });
});
