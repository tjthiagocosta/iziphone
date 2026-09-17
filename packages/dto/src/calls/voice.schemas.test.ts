import { describe, expect, test } from 'vitest';
import {
  CallControlRefusalSchema,
  HoldCallSchema,
  TransferCallSchema,
  VoiceHangupResponseSchema,
  VoiceHoldResponseSchema,
  VoiceTokenResponseSchema,
  VoiceTransferCancelResponseSchema,
  VoiceTransferResponseSchema,
} from './voice.schemas.js';

describe('VoiceTokenResponseSchema', () => {
  test('accepts the token the controller issues', () => {
    expect(
      VoiceTokenResponseSchema.parse({
        jwt: 'twilio-jwt',
        identity: 'user-1',
        provider: 'twilio',
      }),
    ).toEqual({ jwt: 'twilio-jwt', identity: 'user-1', provider: 'twilio' });
  });

  test('rejects an empty token or another provider', () => {
    expect(
      VoiceTokenResponseSchema.safeParse({
        jwt: '',
        identity: 'user-1',
        provider: 'twilio',
      }).success,
    ).toBe(false);
    expect(
      VoiceTokenResponseSchema.safeParse({
        jwt: 'x',
        identity: 'user-1',
        provider: 'vonage',
      }).success,
    ).toBe(false);
  });
});

describe('VoiceHangupResponseSchema', () => {
  test('accepts a hangup with or without a conversation', () => {
    expect(
      VoiceHangupResponseSchema.parse({ success: true, legUuid: 'CA1' }),
    ).toEqual({ success: true, legUuid: 'CA1' });
    expect(
      VoiceHangupResponseSchema.parse({
        success: true,
        legUuid: 'CA1',
        conversationUuid: 'conv-1',
      }).conversationUuid,
    ).toBe('conv-1');
  });

  test('rejects a failed hangup', () => {
    expect(
      VoiceHangupResponseSchema.safeParse({ success: false, legUuid: 'CA1' })
        .success,
    ).toBe(false);
  });
});

describe('call control bodies', () => {
  test('require a target user for transfers', () => {
    expect(TransferCallSchema.safeParse({}).success).toBe(false);
    expect(TransferCallSchema.safeParse({ targetUserId: '  ' }).success).toBe(
      false,
    );
    expect(TransferCallSchema.parse({ targetUserId: ' user-2 ' })).toEqual({
      targetUserId: 'user-2',
    });
  });

  test('require a boolean hold flag', () => {
    expect(HoldCallSchema.safeParse({}).success).toBe(false);
    expect(HoldCallSchema.safeParse({ hold: 'yes' }).success).toBe(false);
    expect(HoldCallSchema.parse({ hold: false })).toEqual({ hold: false });
  });
});

describe('call control responses', () => {
  test('a hold answer says whether the other party is held now', () => {
    expect(
      VoiceHoldResponseSchema.parse({
        success: true,
        conversationUuid: 'conv-1',
        held: true,
      }).held,
    ).toBe(true);
    expect(
      VoiceHoldResponseSchema.safeParse({
        success: true,
        conversationUuid: 'conv-1',
      }).success,
    ).toBe(false);
  });

  test('a transfer answer names the teammate who is ringing', () => {
    expect(
      VoiceTransferResponseSchema.safeParse({
        success: true,
        conversationUuid: 'conv-1',
      }).success,
    ).toBe(false);
    expect(
      VoiceTransferResponseSchema.parse({
        success: true,
        conversationUuid: 'conv-1',
        targetUserId: 'user-2',
      }).targetUserId,
    ).toBe('user-2');
  });

  test('a cancel answer is only ever a success', () => {
    expect(
      VoiceTransferCancelResponseSchema.safeParse({
        success: false,
        conversationUuid: 'conv-1',
      }).success,
    ).toBe(false);
  });

  test('refusal codes are a closed set', () => {
    expect(CallControlRefusalSchema.safeParse('target-offline').success).toBe(
      true,
    );
    expect(CallControlRefusalSchema.safeParse('busy').success).toBe(false);
  });
});
