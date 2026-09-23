import { describe, expect, test } from 'vitest';
import { classifyWebhookWriteFailure } from './webhook-failure.js';

/**
 * The shape the installed client raises: `PrismaClientKnownRequestError` with
 * `code: 'P2002'` and the driver adapter's mapped error under `meta`. Postgres
 * names the constraint, so `index` is the usual case and `fields` the fallback
 * the adapter builds from the error detail.
 */
function uniqueViolation(constraint: { index: string } | { fields: string[] }) {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: {
      modelName: 'Contact',
      driverAdapterError: Object.assign(new Error('duplicate key value'), {
        cause: {
          kind: 'UniqueConstraintViolation',
          constraint,
          originalCode: '23505',
        },
      }),
    },
  });
}

describe('classifyWebhookWriteFailure', () => {
  test('reads a collision on the dedupe key as a delivery we already have', () => {
    expect(
      classifyWebhookWriteFailure(
        uniqueViolation({ index: 'message_provider_events_dedupe_key_key' }),
      ),
    ).toEqual({ kind: 'duplicate-delivery' });

    expect(
      classifyWebhookWriteFailure(uniqueViolation({ fields: ['dedupe_key'] })),
    ).toEqual({ kind: 'duplicate-delivery' });
  });

  test('reads the query engine spelling of the dedupe key as well', () => {
    for (const target of ['dedupeKey', ['dedupeKey']]) {
      expect(
        classifyWebhookWriteFailure(
          Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            meta: { target },
          }),
        ),
      ).toEqual({ kind: 'duplicate-delivery' });
    }
  });

  test('reads a collision on the contact as a race worth running again', () => {
    expect(
      classifyWebhookWriteFailure(
        uniqueViolation({ index: 'contacts_phone_number_key' }),
      ),
    ).toEqual({ kind: 'lost-race', constraint: 'contacts_phone_number_key' });
  });

  test('reads a collision on the conversation as a race worth running again', () => {
    // A conversation is keyed on the contact, the line and the line's owner,
    // a user or a department, and either key can be the one that collided.
    expect(
      classifyWebhookWriteFailure(
        uniqueViolation({
          index:
            'message_conversations_contact_id_source_phone_number_id_use_key',
        }),
      ),
    ).toEqual({
      kind: 'lost-race',
      constraint:
        'message_conversations_contact_id_source_phone_number_id_use_key',
    });
    expect(
      classifyWebhookWriteFailure(
        uniqueViolation({
          fields: ['contact_id', 'source_phone_number_id', 'department_id'],
        }),
      ),
    ).toEqual({
      kind: 'lost-race',
      constraint: 'contact_id,source_phone_number_id,department_id',
    });
  });

  test('never calls a collision it cannot name a duplicate', () => {
    // Answering the provider 200 for an unnamed collision would drop a message
    // that was stored nowhere, so the unnamed case runs again instead.
    expect(
      classifyWebhookWriteFailure(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      ),
    ).toEqual({ kind: 'lost-race', constraint: null });

    expect(
      classifyWebhookWriteFailure(
        uniqueViolation({ fields: ['dedupe_key', 'provider_message_id'] }),
      ),
    ).toMatchObject({ kind: 'lost-race' });
  });

  test('leaves anything that is not a unique violation alone', () => {
    expect(classifyWebhookWriteFailure(new Error('connection lost'))).toEqual({
      kind: 'unrelated',
    });
    expect(
      classifyWebhookWriteFailure(
        Object.assign(new Error('not found'), { code: 'P2025' }),
      ),
    ).toEqual({ kind: 'unrelated' });
    expect(classifyWebhookWriteFailure(null)).toEqual({ kind: 'unrelated' });
    expect(classifyWebhookWriteFailure('P2002')).toEqual({ kind: 'unrelated' });
  });
});
