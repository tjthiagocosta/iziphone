/*
 * The rules about a Twilio recording URL that need no I/O: what of it the API
 * keeps, and which requests it is willing to sign with the account's
 * credentials. Twilio documents the URL as
 * `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}`;
 * the media is that URL with `.mp3` or `.wav`, the resource itself is `.json`.
 */

/** The one host Twilio documents for the Recording resource and its media. */
const TWILIO_API_HOST = 'api.twilio.com';

/** `/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}`, with the SID patterns Twilio documents. */
const RECORDING_PATH =
  /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/Recordings\/(RE[0-9a-fA-F]{32})(?:\.(?:mp3|wav|json))?$/;

/** The requests the API makes about one recording, all on Twilio's host. */
export interface TwilioRecordingRef {
  recordingSid: string;
  /** Fetches the audio as MP3. */
  mediaUrl: string;
  /** The Recording resource itself; a DELETE here removes it at Twilio. */
  resourceUrl: string;
}

/**
 * The SID of the recording a URL names, or null when the URL is not a Twilio
 * recording. Only the SID is kept of a URL that arrived in a webhook.
 */
export function twilioRecordingSid(url: string): string | null {
  return parse(url)?.recordingSid ?? null;
}

/**
 * Where to fetch and delete the recording, or null when the stored URL is not
 * a recording of the account the API holds credentials for.
 *
 * The stored URL arrived in a webhook and the requests carry the account's
 * credentials, so nothing of it is reused but the recording's SID: the
 * requests go to Twilio's API host over https, for a recording of
 * `accountSid`, whatever else the stored value said. A URL on any other host,
 * scheme or port, with credentials of its own, or under another account (a
 * parent account's credentials read its subaccounts' recordings too) is
 * refused rather than rewritten: it is not something Twilio sent this
 * deployment.
 *
 * The audio is requested as MP3. Twilio serves WAV at 128 kbps and MP3 at
 * 32 kbps, every browser plays both, and the browser downloads the whole
 * file before it plays.
 */
export function twilioRecordingRef(
  storedUrl: string,
  accountSid: string,
): TwilioRecordingRef | null {
  const parsed = parse(storedUrl);

  // The hex of a SID reads the same in either case.
  if (parsed?.accountSid.toLowerCase() !== accountSid.toLowerCase()) {
    return null;
  }

  const resource = `https://${TWILIO_API_HOST}/2010-04-01/Accounts/${accountSid}/Recordings/${parsed.recordingSid}`;

  return {
    recordingSid: parsed.recordingSid,
    mediaUrl: `${resource}.mp3`,
    resourceUrl: `${resource}.json`,
  };
}

function parse(
  storedUrl: string,
): { accountSid: string; recordingSid: string } | null {
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
  const accountSid = match?.[1];
  const recordingSid = match?.[2];

  return accountSid && recordingSid ? { accountSid, recordingSid } : null;
}
