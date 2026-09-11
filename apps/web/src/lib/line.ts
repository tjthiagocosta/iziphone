import { formatPhoneNumber } from './phone-number';

/**
 * One of our own numbers, as every view receives it: a conversation's source
 * number, a message sender, a department's number and the number a call was
 * on all carry this pair. Naming a line lives here because a contact has one
 * conversation per line, so a row that does not say which line it is on reads
 * as the same conversation twice.
 */
export interface Line {
  phoneNumber: string;
  label: string | null;
  /**
   * Who the number belongs to, when the caller knows: a department or a
   * person names an unlabelled line better than its digits do.
   */
  ownerName?: string | null;
}

/** What a line is called where there is room for one name. */
export function lineName(line: Line): string {
  return (
    line.label?.trim() ||
    line.ownerName?.trim() ||
    formatPhoneNumber(line.phoneNumber)
  );
}

/**
 * Name and number together, for a header or a picker with room for both.
 *
 * The formatted number brings its own parentheses, so the two are separated
 * rather than nested: `Support · (555) 555-0188`, not the `Support ((555)
 * 555-0188)` that wrapping produces. An unnamed line is its number once.
 */
export function lineDescription(line: Line): string {
  const number = formatPhoneNumber(line.phoneNumber);
  const name = lineName(line);

  return name === number ? number : `${name} · ${number}`;
}
