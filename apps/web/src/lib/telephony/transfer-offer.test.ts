import type { IncomingCall, Teammate } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import { transferredByName } from './transfer-offer';

describe('transferredByName', () => {
  const teammates: Teammate[] = [
    { id: 'user-8', name: 'Avery Stone', departments: ['Support'] },
    { id: 'user-9', name: 'Morgan Reyes', departments: [] },
  ];
  const offer: IncomingCall = {
    conversationUuid: 'CAcall1',
    from: '+15555550123',
    to: '+15555550100',
  };

  test('an ordinary inbound call is handed over by nobody', () => {
    expect(transferredByName(offer, teammates)).toBeNull();
  });

  test('a transferred call names the teammate handing it over', () => {
    expect(
      transferredByName(
        { ...offer, transferredBy: { userId: 'user-9' } },
        teammates,
      ),
    ).toBe('Morgan Reyes');
  });

  test('a transfer from someone the list does not have still reads as one', () => {
    expect(
      transferredByName(
        { ...offer, transferredBy: { userId: 'user-404' } },
        [],
      ),
    ).toBe('a teammate');
  });
});
