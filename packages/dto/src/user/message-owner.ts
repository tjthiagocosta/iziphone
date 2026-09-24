import type { MessageOwner } from './messaging.schemas.js';

/** A user or a department, by id: whom a line or a conversation belongs to. */
export type MessageOwnerRef = Pick<MessageOwner, 'type' | 'id'>;

/**
 * Whether two owners are the same user or the same department.
 *
 * A conversation keeps the owner its line had when it began, and only the
 * line's current owner writes on it: a thread is written in only while its
 * owner still holds the line, and a new message is filed only under an owner
 * that holds it. The API refuses a send on that rule and the composer checks
 * it before anything is typed, so both ask here. An owner that is missing, a
 * line nobody holds, is never the same as another.
 */
export function isSameMessageOwner(
  left: MessageOwnerRef | null | undefined,
  right: MessageOwnerRef | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return left.type === right.type && left.id === right.id;
}
