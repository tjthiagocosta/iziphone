import {
  type AvailablePhoneNumber,
  type ContainsAt,
  type PhoneNumberType,
  type SearchAvailableNumbers,
  SearchAvailableNumbersSchema,
} from '@repo/dto';

/**
 * How many numbers one search asks for: the most Twilio answers at once. It
 * has no next page; each search is a fresh sample, so "Show more" asks again.
 */
export const SEARCH_RESULT_COUNT = 30;

/** The purchase dialog's search form, as typed. */
export interface NumberSearchForm {
  type: PhoneNumberType;
  areaCode: string;
  /** Two-letter state. */
  region: string;
  /** City. */
  locality: string;
  /** Digits, or letters that stand for their keypad digits. */
  contains: string;
  containsAt: ContainsAt;
}

export type NumberSearchField = 'areaCode' | 'region' | 'locality' | 'contains';

export const EMPTY_NUMBER_SEARCH: NumberSearchForm = {
  type: 'LOCAL',
  areaCode: '',
  region: '',
  locality: '',
  contains: '',
  containsAt: 'anywhere',
};

export type NumberSearchRequest =
  | { ok: true; query: SearchAvailableNumbers }
  | { ok: false; errors: Partial<Record<NumberSearchField, string>> };

const SEARCH_FIELDS: readonly NumberSearchField[] = [
  'areaCode',
  'region',
  'locality',
  'contains',
];

/**
 * Turns the form into the query the API takes, or says what is wrong with
 * each field. Empty fields are left out, and a toll-free search drops the
 * place filters instead of refusing them, since the form hides those fields
 * for toll-free numbers but keeps what was typed in case the type goes back.
 */
export function toSearchQuery(form: NumberSearchForm): NumberSearchRequest {
  const local = form.type === 'LOCAL';
  const contains = filled(form.contains);
  const result = SearchAvailableNumbersSchema.safeParse({
    type: form.type,
    areaCode: local ? filled(form.areaCode) : undefined,
    region: local ? filled(form.region) : undefined,
    locality: local ? filled(form.locality) : undefined,
    contains,
    containsAt: contains && form.containsAt === 'end' ? 'end' : undefined,
    limit: SEARCH_RESULT_COUNT,
  });

  if (result.success) {
    return { ok: true, query: result.data };
  }

  const errors: Partial<Record<NumberSearchField, string>> = {};

  for (const issue of result.error.issues) {
    const field = SEARCH_FIELDS.find((name) => name === issue.path[0]);

    if (field && !errors[field]) {
      errors[field] = issue.message;
    }
  }

  return { ok: false, errors };
}

function filled(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The numbers on show once a search answers, and how many of them it added. */
export interface FoundNumbers {
  numbers: AvailablePhoneNumber[];
  added: number;
}

/**
 * Adds the numbers a search found to those already on show, in number order
 * so an admin can scan for one they like. Twilio answers each search with a
 * fresh sample, so a number found twice is shown once.
 */
export function addFoundNumbers(
  shown: readonly AvailablePhoneNumber[],
  found: readonly AvailablePhoneNumber[],
): FoundNumbers {
  const byNumber = new Map(shown.map((number) => [number.phoneNumber, number]));
  let added = 0;

  for (const number of found) {
    if (!byNumber.has(number.phoneNumber)) {
      byNumber.set(number.phoneNumber, number);
      added++;
    }
  }

  const numbers = [...byNumber.values()].sort((a, b) =>
    a.phoneNumber < b.phoneNumber ? -1 : a.phoneNumber > b.phoneNumber ? 1 : 0,
  );

  return { numbers, added };
}
