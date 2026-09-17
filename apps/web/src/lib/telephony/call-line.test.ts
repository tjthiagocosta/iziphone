import type { OutboundCallLine } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  type CallLines,
  callBackFromLine,
  callFromChosenLine,
  callFromConversationLine,
  callLinesOf,
  chosenLineIdFor,
  defaultCallLine,
  nextCallLinesAnswer,
} from './call-line';

function line(overrides: Partial<OutboundCallLine>): OutboundCallLine {
  return {
    id: 'pn-own',
    phoneNumber: '+15555550101',
    label: null,
    ownerType: 'user',
    ownerId: 'user-1',
    ownerName: 'Alex Example',
    isPrimary: false,
    ...overrides,
  };
}

const own = line({});
const support = line({
  id: 'pn-support',
  phoneNumber: '+15555550102',
  label: 'Support',
  ownerType: 'department',
  ownerId: 'dept-1',
  ownerName: 'Support',
  isPrimary: true,
});
const sales = line({
  id: 'pn-sales',
  phoneNumber: '+15555550103',
  ownerType: 'department',
  ownerId: 'dept-2',
  ownerName: 'Sales',
});

const loaded = (lines: OutboundCallLine[]): CallLines => ({
  status: 'loaded',
  lines,
});

describe('callLinesOf', () => {
  const signedIn = { userId: 'user-1', isLoading: false };

  test('is loading while the session is, and while the lines of its user are on their way', () => {
    expect(callLinesOf({ userId: undefined, isLoading: true }, null)).toEqual({
      status: 'loading',
    });
    expect(callLinesOf(signedIn, null)).toEqual({ status: 'loading' });
  });

  test('stops saying it is loading once there is no session to load them for', () => {
    expect(callLinesOf({ userId: undefined, isLoading: false }, null)).toEqual({
      status: 'signed-out',
    });
  });

  test('hands over the lines the request came back with, or that it failed', () => {
    expect(callLinesOf(signedIn, { userId: 'user-1', lines: [own] })).toEqual({
      status: 'loaded',
      lines: [own],
    });
    expect(callLinesOf(signedIn, { userId: 'user-1', lines: null })).toEqual({
      status: 'failed',
    });
  });

  test('never shows one user the lines that were loaded for another', () => {
    expect(
      callLinesOf(signedIn, { userId: 'user-2', lines: [support] }),
    ).toEqual({ status: 'loading' });
  });
});

describe('nextCallLinesAnswer', () => {
  test('keeps the lines that loaded when a later refresh for the same user fails', () => {
    const previous = { userId: 'user-1', lines: [own] };

    expect(
      nextCallLinesAnswer(previous, { userId: 'user-1', lines: null }),
    ).toBe(previous);
  });

  test('takes a refreshed list, so a line the user lost stops being offered', () => {
    const refreshed = { userId: 'user-1', lines: [own] };

    expect(
      nextCallLinesAnswer(
        { userId: 'user-1', lines: [own, support] },
        refreshed,
      ),
    ).toBe(refreshed);
  });

  test('reports a failure when nothing had loaded, or what had was for someone else', () => {
    const failed = { userId: 'user-1', lines: null };

    expect(nextCallLinesAnswer(null, failed)).toBe(failed);
    expect(
      nextCallLinesAnswer({ userId: 'user-2', lines: [support] }, failed),
    ).toBe(failed);
  });

  test('lets a retry replace a failure', () => {
    const retried = { userId: 'user-1', lines: [own] };

    expect(
      nextCallLinesAnswer({ userId: 'user-1', lines: null }, retried),
    ).toBe(retried);
  });
});

describe('chosenLineIdFor', () => {
  test('applies a choice to the user who made it', () => {
    expect(
      chosenLineIdFor({ userId: 'user-1', lineId: 'pn-support' }, 'user-1'),
    ).toBe('pn-support');
  });

  test('does not hand a choice to the next user of the tab, or to nobody', () => {
    const choice = { userId: 'user-1', lineId: 'pn-support' };

    expect(chosenLineIdFor(choice, 'user-2')).toBeNull();
    expect(chosenLineIdFor(choice, undefined)).toBeNull();
    expect(chosenLineIdFor(null, 'user-1')).toBeNull();
  });
});

describe('defaultCallLine', () => {
  test('prefers a number of the user over a department line, however the list is ordered', () => {
    expect(defaultCallLine([support, sales, own])).toBe(own);
  });

  test('falls back to the first department line for a user without a number of their own', () => {
    expect(defaultCallLine([support, sales])).toBe(support);
  });

  test('is nothing for a user without lines', () => {
    expect(defaultCallLine([])).toBeNull();
  });
});

describe('callFromChosenLine', () => {
  test('uses the default line until the user chooses one', () => {
    expect(callFromChosenLine(loaded([own, support]), null)).toEqual({
      canCall: true,
      line: own,
    });
  });

  test('uses the line the user chose', () => {
    expect(callFromChosenLine(loaded([own, support]), 'pn-support')).toEqual({
      canCall: true,
      line: support,
    });
  });

  test('falls back to the default when the chosen line is no longer offered', () => {
    expect(callFromChosenLine(loaded([own, sales]), 'pn-support')).toEqual({
      canCall: true,
      line: own,
    });
  });

  test('says why nobody can call while the lines load, when they fail to, without a session, and when there are none', () => {
    expect(callFromChosenLine({ status: 'loading' }, null)).toEqual({
      canCall: false,
      reason: 'Loading the numbers you can call from…',
    });
    expect(callFromChosenLine({ status: 'failed' }, null)).toEqual({
      canCall: false,
      reason: 'The numbers you can call from could not be loaded.',
    });
    expect(callFromChosenLine({ status: 'signed-out' }, null)).toEqual({
      canCall: false,
      reason: 'You are not signed in.',
    });
    expect(callFromChosenLine(loaded([]), null)).toEqual({
      canCall: false,
      reason:
        'You have no number to call from. Ask an administrator to assign you one.',
    });
  });
});

describe('callFromConversationLine', () => {
  test('calls from the line the conversation is on, not from the default', () => {
    expect(
      callFromConversationLine(loaded([own, support]), support.phoneNumber),
    ).toEqual({ canCall: true, line: support });
  });

  test('refuses a conversation on a line the user may read but not call from', () => {
    expect(
      callFromConversationLine(loaded([own]), support.phoneNumber),
    ).toEqual({
      canCall: false,
      reason: 'You cannot call from the number this conversation is on.',
    });
  });

  test('says the user has no number before saying this one is not theirs', () => {
    expect(callFromConversationLine(loaded([]), support.phoneNumber)).toEqual({
      canCall: false,
      reason:
        'You have no number to call from. Ask an administrator to assign you one.',
    });
  });

  test('says the lines are still loading rather than that the line is not theirs', () => {
    expect(
      callFromConversationLine({ status: 'loading' }, support.phoneNumber),
    ).toEqual({
      canCall: false,
      reason: 'Loading the numbers you can call from…',
    });
  });
});

describe('callBackFromLine', () => {
  test('calls back from the line the call was on', () => {
    expect(
      callBackFromLine(loaded([own, support]), support.phoneNumber, null),
    ).toEqual({ canCall: true, line: support });
  });

  test('calls back from the chosen or default line when the call was on a line the user cannot use', () => {
    expect(
      callBackFromLine(loaded([own, sales]), support.phoneNumber, null),
    ).toEqual({ canCall: true, line: own });
    expect(
      callBackFromLine(loaded([own, sales]), support.phoneNumber, 'pn-sales'),
    ).toEqual({ canCall: true, line: sales });
  });

  test('still calls back a record from before calls had a line, whose line is a user id', () => {
    expect(callBackFromLine(loaded([own]), 'user-1', null)).toEqual({
      canCall: true,
      line: own,
    });
  });

  test('says why when the user has no line at all', () => {
    expect(callBackFromLine(loaded([]), support.phoneNumber, null)).toEqual({
      canCall: false,
      reason:
        'You have no number to call from. Ask an administrator to assign you one.',
    });
  });
});
