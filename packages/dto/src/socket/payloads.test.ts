import { describe, expect, test } from 'vitest';
import {
  CallEndedSchema,
  CallTransferOutcomeSchema,
  IncomingCallSchema,
  MessageActivitySchema,
  UserSocketRegistrationSchema,
} from './payloads.js';

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

describe('IncomingCallSchema', () => {
  const offer = {
    conversationUuid: 'conv-1',
    from: '+15555550123',
    to: '+15555550100',
  };

  test('an ordinary offer carries nobody handing it over', () => {
    expect(IncomingCallSchema.parse(offer).transferredBy).toBeUndefined();
  });

  test('a transferred offer names the teammate by id', () => {
    expect(
      IncomingCallSchema.parse({
        ...offer,
        transferredBy: { userId: 'user-1' },
      }).transferredBy,
    ).toEqual({ userId: 'user-1' });
    expect(
      IncomingCallSchema.safeParse({ ...offer, transferredBy: {} }).success,
    ).toBe(false);
  });
});

describe('MessageActivitySchema', () => {
  test('names the conversation and what happened to it, nothing more', () => {
    expect(
      MessageActivitySchema.parse({
        kind: 'received',
        conversationId: 'conversation-1',
        body: 'Hello there',
        from: '+15555550123',
      }),
    ).toEqual({ kind: 'received', conversationId: 'conversation-1' });
  });

  test('rejects an empty conversation id and an unknown kind', () => {
    expect(
      MessageActivitySchema.safeParse({ kind: 'received', conversationId: '' })
        .success,
    ).toBe(false);
    expect(
      MessageActivitySchema.safeParse({
        kind: 'read',
        conversationId: 'conversation-1',
      }).success,
    ).toBe(false);
  });
});

describe('CallTransferOutcomeSchema', () => {
  const outcome = { conversationUuid: 'conv-1', targetUserId: 'user-2' };

  test('accepts a completed transfer and a failed one with its reason', () => {
    expect(
      CallTransferOutcomeSchema.parse({ ...outcome, status: 'completed' }),
    ).toEqual({ ...outcome, status: 'completed' });
    expect(
      CallTransferOutcomeSchema.parse({
        ...outcome,
        status: 'failed',
        reason: 'declined',
      }).reason,
    ).toBe('declined');
  });

  test('rejects an unknown status or reason', () => {
    expect(
      CallTransferOutcomeSchema.safeParse({ ...outcome, status: 'ringing' })
        .success,
    ).toBe(false);
    expect(
      CallTransferOutcomeSchema.safeParse({
        ...outcome,
        status: 'failed',
        reason: 'busy',
      }).success,
    ).toBe(false);
  });
});
