/*
 * What the call controller keeps about each call while it lasts. Only the
 * call controller reads and writes these keys; they are declared here so
 * that every Redis key prefix has one home.
 *
 *   telephony:call:{conversationUuid}  the call's state, versioned
 *   telephony:calls                    set of the conversation ids with a
 *                                      state, for the claim renewal
 *   telephony:leg:{legUuid}            which call and participant a leg is
 *   telephony:reconcile                the controller instance that last
 *                                      asked Twilio about every live call,
 *                                      until it lapses
 */

export const TELEPHONY = {
  CALL_KEY_PREFIX: 'telephony:call:',
  LIVE_CALLS_KEY: 'telephony:calls',
  LEG_KEY_PREFIX: 'telephony:leg:',
  RECONCILE_LOCK_KEY: 'telephony:reconcile',
} as const;
