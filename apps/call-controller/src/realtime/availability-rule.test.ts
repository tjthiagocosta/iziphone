import { describe, expect, test } from 'vitest';
import { decideAvailability } from './availability-rule.js';

const free = { sockets: 1, doNotDisturb: false, calls: [] };

describe('decideAvailability', () => {
  test('a connected user with no call and no do not disturb is available', () => {
    expect(decideAvailability(free)).toBe('available');
  });

  test('a user with no connected softphone is offline, whatever else is true', () => {
    expect(
      decideAvailability({ sockets: 0, doNotDisturb: true, calls: ['CA1'] }),
    ).toBe('offline');
  });

  test('do not disturb keeps a connected user from calls', () => {
    expect(decideAvailability({ ...free, doNotDisturb: true })).toBe('dnd');
  });

  test('do not disturb is the reason given for a user who is also on a call', () => {
    expect(
      decideAvailability({ sockets: 2, doNotDisturb: true, calls: ['CA1'] }),
    ).toBe('dnd');
  });

  test('a call claiming the user makes them busy', () => {
    expect(decideAvailability({ ...free, calls: ['CA1'] })).toBe('busy');
  });

  test('the call being offered does not make its own user busy', () => {
    expect(decideAvailability({ ...free, calls: ['CA1'] }, 'CA1')).toBe(
      'available',
    );
  });

  test('another call still makes the user busy for the one being offered', () => {
    expect(decideAvailability({ ...free, calls: ['CA1', 'CA2'] }, 'CA1')).toBe(
      'busy',
    );
  });
});
