import type { Call } from '@twilio/voice-sdk';
import { describe, expect, test } from 'vitest';
import { getCallSid } from './useTelephonyClient';

describe('getCallSid', () => {
  test('should prefer the real outgoing Twilio CallSID', () => {
    const call = {
      parameters: {
        CallSID: 'CA_outgoing_real_sid',
      },
      outboundConnectionId: 'temp-connection-id',
    } as unknown as Call;

    expect(getCallSid(call)).toBe('CA_outgoing_real_sid');
  });

  test('should read incoming CallSid payloads', () => {
    const call = {
      parameters: {
        CallSid: 'CA_incoming_sid',
      },
    } as unknown as Call;

    expect(getCallSid(call)).toBe('CA_incoming_sid');
  });

  test('should ignore SDK-local outbound connection ids', () => {
    const call = {
      parameters: {},
      outboundConnectionId: 'temp-connection-id',
    } as unknown as Call;

    expect(getCallSid(call)).toBeNull();
  });
});
