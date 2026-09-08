import { describe, expect, test } from 'vitest';
import { CallEndedSchema, UserSocketRegistrationSchema } from './payloads.js';

describe('UserSocketRegistrationSchema', () => {
  test('accepts an empty registration', () => {
    expect(UserSocketRegistrationSchema.parse({})).toEqual({});
  });

  test('drops a client-supplied userId so it can never override the session', () => {
    const parsed = UserSocketRegistrationSchema.parse({
      userId: 'someone-else',
      deviceInfo: { platform: 'web' },
    });
    expect(parsed).toEqual({ deviceInfo: { platform: 'web' } });
  });
});

describe('CallEndedSchema', () => {
  test('requires a known status and an ISO timestamp', () => {
    expect(
      CallEndedSchema.safeParse({
        conversationUuid: 'conv-1',
        status: 'hung-up',
        endedAt: '2026-04-21T12:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      CallEndedSchema.safeParse({
        conversationUuid: 'conv-1',
        status: 'completed',
        duration: 42,
        endedAt: '2026-04-21T12:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
