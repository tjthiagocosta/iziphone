import type { UserAvailability } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  applyOwnAnswer,
  applyOwnEvent,
  applyOwnSnapshot,
  indicatorStatus,
  mergeTeammateAvailability,
  type OwnAvailability,
  transferChoiceOf,
} from './availability';

const known: OwnAvailability = { doNotDisturb: false, revision: 5 };

function event(
  state: UserAvailability['state'],
  revision: number,
): UserAvailability {
  return { userId: 'user-1', state, revision };
}

/** What the controller answers about the user, at a revision. */
function snapshot(revision: number, doNotDisturb: boolean) {
  return {
    availability: {
      userId: 'user-1',
      state: doNotDisturb ? ('dnd' as const) : ('available' as const),
      revision,
    },
    doNotDisturb,
  };
}

describe('applyOwnEvent', () => {
  test('applies an event newer than what is known', () => {
    expect(applyOwnEvent(known, event('dnd', 6))).toEqual({
      doNotDisturb: true,
      revision: 6,
    });
  });

  test('ignores an event older than what is known', () => {
    expect(applyOwnEvent(known, event('dnd', 4))).toBe(known);
  });

  test('ignores an event at the revision already known', () => {
    expect(applyOwnEvent(known, event('dnd', 5))).toBe(known);
  });

  test('applies the first event when nothing is known yet', () => {
    expect(applyOwnEvent(null, event('busy', 2))).toEqual({
      doNotDisturb: false,
      revision: 2,
    });
  });

  test('keeps do not disturb as it was while the user reads as offline', () => {
    expect(
      applyOwnEvent({ ...known, doNotDisturb: true }, event('offline', 6)),
    ).toEqual({ doNotDisturb: true, revision: 6 });
  });

  test('learns nothing from reading as offline when nothing is known', () => {
    expect(applyOwnEvent(null, event('offline', 6))).toBeNull();
  });
});

describe('applyOwnSnapshot', () => {
  test('replaces what is known with a snapshot at least as new', () => {
    expect(applyOwnSnapshot(known, snapshot(5, true))).toEqual({
      doNotDisturb: true,
      revision: 5,
    });
  });

  test('keeps an event that overtook an older snapshot', () => {
    expect(applyOwnSnapshot(known, snapshot(3, true))).toBe(known);
  });

  test('takes a snapshot when nothing is known, whatever its revision', () => {
    expect(applyOwnSnapshot(null, snapshot(0, false))).toEqual({
      doNotDisturb: false,
      revision: 0,
    });
  });
});

describe('applyOwnAnswer', () => {
  test('takes the answer to the user switching do not disturb, after the controller began its revisions again', () => {
    const beforeTheRestart: OwnAvailability = {
      doNotDisturb: false,
      revision: 57,
    };

    const own = applyOwnAnswer(snapshot(1, true));

    expect(own).toEqual({ doNotDisturb: true, revision: 1 });
    // What follows the answer counts from its revision, not from the old one.
    expect(applyOwnEvent(own, event('available', 2))).toEqual({
      doNotDisturb: false,
      revision: 2,
    });
    expect(applyOwnEvent(beforeTheRestart, event('available', 2))).toBe(
      beforeTheRestart,
    );
  });
});

describe('mergeTeammateAvailability', () => {
  test('keeps the newer word on each teammate', () => {
    const current = new Map([
      ['user-2', { userId: 'user-2', state: 'busy', revision: 7 } as const],
      ['user-3', { userId: 'user-3', state: 'busy', revision: 2 } as const],
    ]);

    const merged = mergeTeammateAvailability(current, [
      { userId: 'user-2', state: 'available', revision: 6 },
      { userId: 'user-3', state: 'available', revision: 3 },
      { userId: 'user-4', state: 'dnd', revision: 1 },
    ]);

    expect(Object.fromEntries(merged)).toEqual({
      'user-2': { userId: 'user-2', state: 'busy', revision: 7 },
      'user-3': { userId: 'user-3', state: 'available', revision: 3 },
      'user-4': { userId: 'user-4', state: 'dnd', revision: 1 },
    });
  });
});

describe('transferChoiceOf', () => {
  test.each([
    ['busy', 'On a call'],
    ['dnd', 'Do not disturb'],
    ['offline', 'Offline'],
  ] as const)(
    'a teammate who is %s cannot be picked, and says why',
    (state, reason) => {
      expect(transferChoiceOf(state)).toEqual({ selectable: false, reason });
    },
  );

  test('an available teammate can be picked', () => {
    expect(transferChoiceOf('available')).toEqual({
      selectable: true,
      reason: null,
    });
  });

  test('a teammate not known yet can be picked; the controller has the last word', () => {
    expect(transferChoiceOf(undefined)).toEqual({
      selectable: true,
      reason: null,
    });
  });
});

describe('indicatorStatus', () => {
  test('shows do not disturb on a phone that is online', () => {
    expect(indicatorStatus('online', true)).toBe('dnd');
  });

  test('shows the connection while it is not up, do not disturb or not', () => {
    expect(indicatorStatus('connecting', true)).toBe('connecting');
    expect(indicatorStatus('offline', null)).toBe('offline');
  });

  test('shows online when do not disturb is off or not known', () => {
    expect(indicatorStatus('online', false)).toBe('online');
    expect(indicatorStatus('online', null)).toBe('online');
  });
});
