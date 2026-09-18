import { describe, expect, test } from 'vitest';
import { twilioRecordingRef, twilioRecordingSid } from './twilio-recording.js';

const accountSid = 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const recordingSid = 'REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const recording = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}`;

/** URLs that are not a Twilio recording, whatever account is asked about. */
const notARecording = [
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
];

describe('twilioRecordingSid', () => {
  test('reads the SID of the recording Twilio named', () => {
    expect(twilioRecordingSid(recording)).toBe(recordingSid);
  });

  test.each([
    { name: 'a WAV extension', stored: `${recording}.wav` },
    { name: 'an MP3 extension', stored: `${recording}.mp3` },
    { name: 'the JSON resource', stored: `${recording}.json` },
    { name: 'a query string', stored: `${recording}?RequestedChannels=2` },
    { name: 'a fragment', stored: `${recording}#t=10` },
  ])('reads the SID of a URL with $name', ({ stored }) => {
    expect(twilioRecordingSid(stored)).toBe(recordingSid);
  });

  test('reads the SID of a recording of any account', () => {
    expect(
      twilioRecordingSid(
        recording.replace(accountSid, 'ACcccccccccccccccccccccccccccccccc'),
      ),
    ).toBe(recordingSid);
  });

  test.each(notARecording)('finds none in $name', ({ stored }) => {
    expect(twilioRecordingSid(stored)).toBeNull();
  });
});

describe('twilioRecordingRef', () => {
  test('asks for the MP3 and names the resource to delete', () => {
    expect(twilioRecordingRef(recording, accountSid)).toEqual({
      recordingSid,
      mediaUrl: `${recording}.mp3`,
      resourceUrl: `${recording}.json`,
    });
  });

  test('reads an account SID the same in either case', () => {
    expect(
      twilioRecordingRef(
        recording.replace(accountSid, 'ACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        accountSid,
      ),
    ).toMatchObject({ mediaUrl: `${recording}.mp3` });
  });

  test.each([
    { name: 'a WAV extension', stored: `${recording}.wav` },
    { name: 'an MP3 extension', stored: `${recording}.mp3` },
    { name: 'a query string', stored: `${recording}?RequestedChannels=2` },
    { name: 'a fragment', stored: `${recording}#t=10` },
  ])('keeps only the recording SID of a URL with $name', ({ stored }) => {
    expect(twilioRecordingRef(stored, accountSid)).toMatchObject({
      mediaUrl: `${recording}.mp3`,
      resourceUrl: `${recording}.json`,
    });
  });

  test.each([
    ...notARecording,
    {
      // A parent account's credentials would be honoured for a subaccount's.
      name: 'a recording of another account',
      stored: recording.replace(
        accountSid,
        'ACcccccccccccccccccccccccccccccccc',
      ),
    },
  ])('refuses $name', ({ stored }) => {
    expect(twilioRecordingRef(stored, accountSid)).toBeNull();
  });
});
