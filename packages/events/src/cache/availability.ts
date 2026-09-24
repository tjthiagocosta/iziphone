/*
 * Whether a user can be offered a call. Only the call controller reads and
 * writes these keys; they are declared here so that every Redis key prefix
 * has one home.
 *
 *   availability:user:{userId}    hash: `dnd` ("1" while do not disturb is
 *                                 on), `revision` (grows with every change to
 *                                 DND or claims, and whenever one of the
 *                                 user's softphones registers or goes away),
 *                                 `availableSince` (ms on Redis's clock) and
 *                                 `sinceRevision`
 *   availability:claims:{userId}  sorted set of the calls occupying the user,
 *                                 scored by when each claim was last renewed
 *                                 (ms on Redis's clock)
 *
 * Neither is a saved preference: flushing Redis turns everybody's do not
 * disturb off and frees everybody, exactly as it ends every call.
 */

export const AVAILABILITY = {
  USER_KEY_PREFIX: 'availability:user:',
  CLAIMS_KEY_PREFIX: 'availability:claims:',
  /** How often the controller renews the claims of every call still going. */
  CLAIM_RENEW_INTERVAL_MS: 30_000,
  /**
   * A claim nobody renewed for this long no longer counts. Three renewals,
   * so two can be lost in a row (Redis unreachable, a stalled event loop)
   * before a user on a call can be offered another; and a claim whose
   * release was lost frees its user within this long of the call going.
   */
  CLAIM_LIFETIME_MS: 90_000,
} as const;
