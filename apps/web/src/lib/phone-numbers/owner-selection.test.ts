import { describe, expect, test } from 'vitest';
import {
  chosenHolder,
  ownerOf,
  RESERVE_SELECTION,
  sameHolder,
  selectionOf,
  withKind,
} from './owner-selection';

const ALEX = { type: 'user', id: 'user-alex', name: 'Alex Example' } as const;
const SALES = { type: 'department', id: 'dept-sales', name: 'Sales' } as const;

describe('selectionOf', () => {
  test('starts from the current holder, or the reserve', () => {
    expect(selectionOf(ALEX)).toEqual({ kind: 'user', holder: ALEX });
    expect(selectionOf(null)).toEqual(RESERVE_SELECTION);
  });
});

describe('withKind', () => {
  test('forgets a holder of another kind', () => {
    expect(withKind(selectionOf(ALEX), 'department')).toEqual({
      kind: 'department',
      holder: null,
    });
  });

  test('keeps the holder when the kind does not change', () => {
    expect(withKind(selectionOf(SALES), 'department')).toEqual(
      selectionOf(SALES),
    );
  });

  test('chooses the reserve outright', () => {
    expect(withKind(selectionOf(ALEX), 'reserve')).toEqual(RESERVE_SELECTION);
  });
});

describe('chosenHolder', () => {
  test('is undefined until somebody of the chosen kind is picked', () => {
    expect(chosenHolder({ kind: 'user', holder: null })).toBeUndefined();
    expect(chosenHolder(selectionOf(ALEX))).toEqual(ALEX);
    expect(chosenHolder(RESERVE_SELECTION)).toBeNull();
  });
});

describe('ownerOf', () => {
  test('sends only the kind and id', () => {
    expect(ownerOf(SALES)).toEqual({ type: 'department', id: 'dept-sales' });
    expect(ownerOf(null)).toBeNull();
  });
});

describe('sameHolder', () => {
  test('compares kind and id', () => {
    expect(sameHolder(ALEX, { ...ALEX, name: 'Renamed' })).toBe(true);
    expect(sameHolder(ALEX, SALES)).toBe(false);
    expect(sameHolder(null, null)).toBe(true);
    expect(sameHolder(ALEX, null)).toBe(false);
  });
});
