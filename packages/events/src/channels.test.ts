import { describe, expect, test } from 'vitest';
import { CHANNELS, COMMAND_CHANNELS, EVENT_CHANNELS } from './channels.js';

describe('channels', () => {
  test('every channel is either an event or a command, never both', () => {
    const all = Object.values(CHANNELS).sort();
    const classified = [...EVENT_CHANNELS, ...COMMAND_CHANNELS].sort();
    expect(classified).toEqual(all);
    expect(new Set(classified).size).toBe(all.length);
  });

  test('hold and transfer are not commands: the softphone asks the controller', () => {
    expect(COMMAND_CHANNELS).toEqual(['call:hangup']);
    expect(Object.values(CHANNELS)).not.toContain('call:hold');
    expect(Object.values(CHANNELS)).not.toContain('call:transfer');
  });

  test('channel names are unique', () => {
    const names = Object.values(CHANNELS);
    expect(new Set(names).size).toBe(names.length);
  });
});
