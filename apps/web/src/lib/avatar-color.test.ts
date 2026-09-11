import { describe, expect, test } from 'vitest';
import { AVATAR_COLORS, avatarColorFor } from './avatar-color';

describe('avatarColorFor', () => {
  test('always returns a colour from the palette', () => {
    for (const id of [
      'contact-1',
      'contact-2',
      '',
      '+15550100104',
      'x'.repeat(200),
    ]) {
      expect(AVATAR_COLORS).toContain(avatarColorFor(id));
    }
  });

  test('is stable for the same identifier', () => {
    expect(avatarColorFor('contact-7')).toBe(avatarColorFor('contact-7'));
  });

  test('spreads a run of ids across more than one colour', () => {
    const seen = new Set(
      Array.from({ length: 20 }, (_, i) => avatarColorFor(`contact-${i}`)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
