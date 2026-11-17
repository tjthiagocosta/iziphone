import { describe, expect, test } from 'vitest';
import { lastPageIfPastEnd } from './list-page';

describe('lastPageIfPastEnd', () => {
  test('keeps a page the list still reaches', () => {
    expect(lastPageIfPastEnd(1, 3)).toBeNull();
    expect(lastPageIfPastEnd(3, 3)).toBeNull();
  });

  test('goes back to the last page once the page asked for has emptied', () => {
    expect(lastPageIfPastEnd(2, 1)).toBe(1);
    expect(lastPageIfPastEnd(5, 3)).toBe(3);
  });

  test('goes back to the first page when nothing is left', () => {
    expect(lastPageIfPastEnd(2, 0)).toBe(1);
  });

  test('stays on the first page of an empty list', () => {
    expect(lastPageIfPastEnd(1, 0)).toBeNull();
  });
});
