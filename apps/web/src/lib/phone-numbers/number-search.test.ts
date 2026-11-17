import type { AvailablePhoneNumber } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  addFoundNumbers,
  EMPTY_NUMBER_SEARCH,
  SEARCH_RESULT_COUNT,
  toSearchQuery,
} from './number-search';

describe('toSearchQuery', () => {
  test('asks for local numbers anywhere when nothing is filled in', () => {
    expect(toSearchQuery(EMPTY_NUMBER_SEARCH)).toEqual({
      ok: true,
      query: { country: 'US', type: 'LOCAL', limit: SEARCH_RESULT_COUNT },
    });
  });

  test('sends the place filters and digits of a local search', () => {
    expect(
      toSearchQuery({
        ...EMPTY_NUMBER_SEARCH,
        areaCode: '555',
        region: ' tx ',
        locality: 'Springfield ',
        contains: '0101',
        containsAt: 'end',
      }),
    ).toEqual({
      ok: true,
      query: {
        country: 'US',
        type: 'LOCAL',
        areaCode: '555',
        region: 'TX',
        locality: 'Springfield',
        contains: '0101',
        containsAt: 'end',
        limit: SEARCH_RESULT_COUNT,
      },
    });
  });

  test('drops the place filters a toll-free search cannot use', () => {
    expect(
      toSearchQuery({
        ...EMPTY_NUMBER_SEARCH,
        type: 'TOLL_FREE',
        areaCode: '555',
        region: 'TX',
        contains: 'HELP',
      }),
    ).toEqual({
      ok: true,
      query: {
        country: 'US',
        type: 'TOLL_FREE',
        contains: 'HELP',
        limit: SEARCH_RESULT_COUNT,
      },
    });
  });

  test('does not anchor a search with no digits to look for', () => {
    const request = toSearchQuery({
      ...EMPTY_NUMBER_SEARCH,
      containsAt: 'end',
    });

    expect(request).toMatchObject({ ok: true });
    expect(request.ok && request.query.containsAt).toBeUndefined();
  });

  test('names each field that is wrong', () => {
    expect(
      toSearchQuery({
        ...EMPTY_NUMBER_SEARCH,
        areaCode: '55',
        region: 'Texas',
        contains: '0*01',
      }),
    ).toEqual({
      ok: false,
      errors: {
        areaCode: 'Area code must be 3 digits',
        region: 'State must be a two-letter code',
        contains: 'Use 2 to 10 digits or letters',
      },
    });
  });
});

function available(phoneNumber: string): AvailablePhoneNumber {
  return {
    phoneNumber,
    friendlyName: phoneNumber,
    type: 'LOCAL',
    providerType: 'local',
    locality: 'Springfield',
    region: 'IL',
    postalCode: null,
    isoCountry: 'US',
    capabilities: { voice: true, sms: true, mms: true },
  };
}

const numbersOf = (found: { numbers: AvailablePhoneNumber[] }) =>
  found.numbers.map((number) => number.phoneNumber);

describe('addFoundNumbers', () => {
  test('shows a first search in number order', () => {
    const found = addFoundNumbers(
      [],
      [
        available('+12175550188'),
        available('+12175550104'),
        available('+12175550142'),
      ],
    );

    expect(numbersOf(found)).toEqual([
      '+12175550104',
      '+12175550142',
      '+12175550188',
    ]);
    expect(found.added).toBe(3);
  });

  test('slots a later search in among the numbers on show', () => {
    const found = addFoundNumbers(
      [available('+12175550104'), available('+12175550188')],
      [available('+12175550150'), available('+12175550101')],
    );

    expect(numbersOf(found)).toEqual([
      '+12175550101',
      '+12175550104',
      '+12175550150',
      '+12175550188',
    ]);
    expect(found.added).toBe(2);
  });

  test('shows a number found twice once, and does not count it as added', () => {
    const shown = [available('+12175550104')];
    const found = addFoundNumbers(shown, [
      available('+12175550104'),
      available('+12175550111'),
    ]);

    expect(numbersOf(found)).toEqual(['+12175550104', '+12175550111']);
    expect(found.added).toBe(1);
  });

  test('says when a search found nothing new', () => {
    const shown = [available('+12175550104')];

    expect(addFoundNumbers(shown, [available('+12175550104')])).toEqual({
      numbers: shown,
      added: 0,
    });
    expect(addFoundNumbers(shown, []).added).toBe(0);
  });
});
