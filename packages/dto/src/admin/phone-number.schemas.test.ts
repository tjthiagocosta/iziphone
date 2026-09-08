import { describe, expect, test } from 'vitest';
import {
  PhoneNumberListQuerySchema,
  PhoneNumberResponseSchema,
  PurchasePhoneNumberSchema,
  SearchAvailableNumbersSchema,
} from './phone-number.schemas.js';

describe('PurchasePhoneNumberSchema', () => {
  test('requires an E.164 number', () => {
    expect(PurchasePhoneNumberSchema.safeParse({ type: 'LOCAL' }).success).toBe(
      false,
    );
    expect(
      PurchasePhoneNumberSchema.safeParse({
        type: 'LOCAL',
        phoneNumber: '5555550100',
      }).success,
    ).toBe(false);
  });

  test('defaults country and isPrimary', () => {
    expect(
      PurchasePhoneNumberSchema.parse({
        type: 'LOCAL',
        phoneNumber: '+15555550100',
      }),
    ).toEqual({
      type: 'LOCAL',
      phoneNumber: '+15555550100',
      country: 'US',
      isPrimary: false,
    });
  });
});

describe('SearchAvailableNumbersSchema', () => {
  test('defaults country and limit', () => {
    expect(SearchAvailableNumbersSchema.parse({ type: 'LOCAL' })).toEqual({
      country: 'US',
      type: 'LOCAL',
      limit: 10,
    });
  });

  test('rejects non-US searches', () => {
    const result = SearchAvailableNumbersSchema.safeParse({
      country: 'CA',
      type: 'LOCAL',
    });
    expect(result.success).toBe(false);
  });

  test('rejects area code searches for toll-free numbers', () => {
    const result = SearchAvailableNumbersSchema.safeParse({
      type: 'TOLL_FREE',
      areaCode: '561',
    });
    expect(result.success).toBe(false);
  });
});

describe('PhoneNumberListQuerySchema', () => {
  test('parses the unassigned flag from a query string', () => {
    expect(
      PhoneNumberListQuerySchema.parse({ unassigned: 'false' }).unassigned,
    ).toBe(false);
  });
});

describe('PhoneNumberResponseSchema', () => {
  test('accepts numbers imported from the previous provider', () => {
    const result = PhoneNumberResponseSchema.safeParse({
      id: 'phone-1',
      phoneNumber: '+15555550100',
      friendlyName: null,
      type: 'LOCAL',
      label: null,
      provider: 'VONAGE',
      locality: null,
      region: null,
      country: 'US',
      voiceEnabled: true,
      smsEnabled: true,
      mmsEnabled: false,
      faxEnabled: false,
      status: 'ACTIVE',
      isPrimary: false,
      assignedTo: null,
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});
