/*
 * A webhook transaction writes the provider event first, whose `dedupeKey` is
 * the guard against the same delivery arriving twice, and then finds-or-creates
 * the contact and the conversation. Both steps can raise the same unique-key
 * error for opposite reasons, so telling them apart decides whether the message
 * is already stored or was just thrown away.
 */

/** The unique index behind `MessageProviderEvent.dedupeKey`, in every spelling. */
const DEDUPE_KEY_NAMES = new Set([
  // Constraint name, as the pg driver adapter reports it.
  'message_provider_events_dedupe_key_key',
  // Column name, from the error detail when the constraint is not named.
  'dedupe_key',
  // Prisma field name, as `meta.target` spells it.
  'dedupeKey',
]);

export type WebhookWriteFailure =
  /** The provider already delivered this event; the stored one stands. */
  | { kind: 'duplicate-delivery' }
  /**
   * Another delivery created the contact or the conversation first and this
   * transaction rolled back. Nothing was kept, so the work has to be done
   * again or the message is lost.
   */
  | { kind: 'lost-race'; constraint: string | null }
  /** Not a unique-key failure; it belongs to whoever called. */
  | { kind: 'unrelated' };

/**
 * Reads a failed webhook transaction. A unique violation counts as a duplicate
 * delivery only when it names the dedupe key: one that cannot be named is
 * treated as a lost race, because calling it a duplicate would answer the
 * provider 200 for a message stored nowhere.
 */
export function classifyWebhookWriteFailure(
  error: unknown,
): WebhookWriteFailure {
  if (readProperty(error, 'code') !== 'P2002') {
    return { kind: 'unrelated' };
  }

  const names = uniqueKeyNames(error);

  if (names.length > 0 && names.every((name) => DEDUPE_KEY_NAMES.has(name))) {
    return { kind: 'duplicate-delivery' };
  }

  return { kind: 'lost-race', constraint: names.join(',') || null };
}

/**
 * The unique key a P2002 collided with. The pg driver adapter reports the
 * constraint name, or the columns from the error detail when Postgres sent no
 * name; `meta.target` is the shape a P2002 raised without a driver adapter
 * carries, kept so a change of adapter cannot turn every collision into a
 * silent duplicate.
 */
function uniqueKeyNames(error: unknown): string[] {
  const meta = readProperty(error, 'meta');
  const constraint = readProperty(
    readProperty(readProperty(meta, 'driverAdapterError'), 'cause'),
    'constraint',
  );

  const index = readProperty(constraint, 'index');
  if (typeof index === 'string') {
    return [index];
  }

  const fields = readProperty(constraint, 'fields');
  if (isStringArray(fields)) {
    return fields;
  }

  const target = readProperty(meta, 'target');
  if (typeof target === 'string') {
    return [target];
  }
  if (isStringArray(target)) {
    return target;
  }

  return [];
}

function readProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string')
  );
}
