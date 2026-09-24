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

/**
 * What one of a contact's threads is called among that contact's threads: its
 * line, unless the reader has more than one thread with the contact on that
 * line. That happens when the line changed hands and the reader can see both
 * owners' threads, and only the current owner's can be written in, so each
 * then names its owner as well.
 */
export function threadLineName(
  thread: {
    sourcePhoneNumber: Line & { id: string };
    owner: { name: string } | null;
  },
  threadsWithContact: ReadonlyArray<{ sourcePhoneNumber: { id: string } }>,
): string {
  const name = lineName(thread.sourcePhoneNumber);
  const onSameLine = threadsWithContact.filter(
    (other) => other.sourcePhoneNumber.id === thread.sourcePhoneNumber.id,
  );

  return onSameLine.length > 1 && thread.owner
    ? `${name} · ${thread.owner.name}`
    : name;
}
