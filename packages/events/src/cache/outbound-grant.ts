/*
 * The grant a softphone places an outbound call on. The call controller
 * issues it over its authenticated API and takes it back from Twilio's
 * webhook, so only the call controller reads and writes it; it is declared
 * here so that every Redis key prefix has one home.
 *
 *   voice:outbound-grant:{token}  -> the caller, the destination and the line
 */

export const OUTBOUND_GRANT = {
  KEY_PREFIX: 'voice:outbound-grant:',
  /**
   * Long enough for the browser to start the call once it has the grant, and
   * short enough that a grant that leaks from a request log is worthless.
   */
  TTL_SECONDS: 60,
} as const;
