import { describe, expect, test } from 'vitest';
import {
  VoiceHangupResponseSchema,
  VoiceTokenResponseSchema,
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
