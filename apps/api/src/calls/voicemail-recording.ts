/*
 * The rules of voicemail playback that need no I/O: which timeline entry
 * names the voicemail's recording, and which URL the API is willing to fetch
 * with the account's credentials.
 */

/** The one host Twilio documents for recording media. */
const TWILIO_API_HOST = 'api.twilio.com';

/** `/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}`, with the SID patterns Twilio documents. */
const RECORDING_PATH =
  /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/Recordings\/(RE[0-9a-fA-F]{32})(?:\.(?:mp3|wav))?$/;

export interface VoicemailTimelineEntry {
  metadata: unknown;
}

/**
 * The URL Twilio gave for the voicemail's recording, from the call's
 * `VOICEMAIL_COMPLETED` entries, newest first.
 *
 * `Call.recordingUrl` is not used: every recording of the call overwrites
 * it, and a call that rang in its conference before falling to voicemail has
 * two. The timeline entry is written for the voicemail only. There can be two
 * of them, one for the recording and one for its transcription, and the
 * second does not always carry the URL, so the first entry that names one
 * wins.
 */
export function voicemailRecordingUrl(
  entries: readonly VoicemailTimelineEntry[],
): string | null {
  for (const { metadata } of entries) {
    if (
      typeof metadata === 'object' &&
      metadata !== null &&
      'recordingUrl' in metadata &&
      typeof metadata.recordingUrl === 'string'
    ) {
      return metadata.recordingUrl;
    }
  }

  return null;
}

/**
 * The URL to fetch the recording's audio from, or null when the stored URL is
 * not a recording of the account the API holds credentials for.
 *
 * The stored URL arrived in a webhook and the fetch carries the account's
 * credentials, so nothing of it is reused but the recording's SID: the request
 * goes to Twilio's API host over https, for a recording of `accountSid`,
 * whatever else the stored value said. A URL on any other host, scheme or
 * port, with credentials of its own, or under another account (a parent
 * account's credentials read its subaccounts' recordings too) is refused
 * rather than rewritten: it is not something Twilio sent this deployment.
 *
 * The audio is requested as MP3. Twilio serves WAV at 128 kbps and MP3 at
 * 32 kbps, every browser plays both, and the browser downloads the whole
 * file before it plays.
 */
export function twilioRecordingMediaUrl(
  storedUrl: string,
  accountSid: string,
): string | null {
  if (!URL.canParse(storedUrl)) {
    return null;
  }

  const url = new URL(storedUrl);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== TWILIO_API_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }

  const match = RECORDING_PATH.exec(url.pathname);
  const storedAccountSid = match?.[1];
  const recordingSid = match?.[2];
  if (
    !recordingSid ||
    // The hex of a SID reads the same in either case.
    storedAccountSid?.toLowerCase() !== accountSid.toLowerCase()
  ) {
    return null;
  }

  return `https://${TWILIO_API_HOST}/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`;
}
