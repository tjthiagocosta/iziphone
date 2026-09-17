import { describe, expect, test } from 'vitest';
import { callStatusLine } from './call-status-line';
import type { TelephonyState, TransferProgress } from './telephony-session';

type CallSnapshot = Pick<
  TelephonyState,
  'callStatus' | 'isOnHold' | 'transfer' | 'endReason'
>;

const connected: CallSnapshot = {
  callStatus: 'connected',
  isOnHold: false,
  transfer: null,
  endReason: 'ended',
};

const toMorgan: TransferProgress = {
  targetUserId: 'user-9',
  targetName: 'Morgan Reyes',
  status: 'ringing',
};

describe('callStatusLine', () => {
  test('a connected call shows how long it has run', () => {
    expect(callStatusLine(connected, 75)).toEqual({
      text: '1:15',
      tone: 'connected',
    });
  });

  test('a held call says so, and keeps the timer', () => {
    expect(callStatusLine({ ...connected, isOnHold: true }, 75)).toEqual({
      text: 'On hold · 1:15',
      tone: 'held',
    });
  });

  test.each<TransferProgress['status']>(['requesting', 'ringing'])(
    'a transfer that is %s names the teammate instead of the hold it implies',
    (status) => {
      expect(
        callStatusLine(
          { ...connected, isOnHold: true, transfer: { ...toMorgan, status } },
          75,
        ),
      ).toEqual({
        text: 'Transferring to Morgan Reyes...',
        tone: 'transferring',
      });
    },
  );

  test('a transfer being called off, or answered, says which', () => {
    expect(
      callStatusLine(
        { ...connected, transfer: { ...toMorgan, status: 'cancelling' } },
        75,
      ).text,
    ).toBe('Cancelling transfer...');
    expect(
      callStatusLine(
        { ...connected, transfer: { ...toMorgan, status: 'answered' } },
        75,
      ).text,
    ).toBe('Morgan Reyes answered');
  });

  test('a call that was handed over does not read as one that ended', () => {
    expect(
      callStatusLine(
        { ...connected, callStatus: 'disconnected', endReason: 'transferred' },
        0,
      ),
    ).toEqual({ text: 'Call transferred', tone: 'over' });
    expect(
      callStatusLine({ ...connected, callStatus: 'disconnected' }, 0),
    ).toEqual({ text: 'Call ended', tone: 'over' });
  });

  test('a call being set up or torn down shows that, whatever else is set', () => {
    expect(callStatusLine({ ...connected, callStatus: 'ringing' }, 0)).toEqual({
      text: 'Ringing...',
      tone: 'ringing',
    });
    expect(
      callStatusLine({ ...connected, callStatus: 'connecting' }, 0),
    ).toEqual({ text: 'Connecting...', tone: 'connecting' });
    expect(
      callStatusLine({ ...connected, callStatus: 'disconnecting' }, 0),
    ).toEqual({ text: 'Ending...', tone: 'ending' });
    expect(callStatusLine({ ...connected, callStatus: 'idle' }, 0).text).toBe(
      '',
    );
  });
});
