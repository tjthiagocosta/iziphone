# 0011. A line's history stays with the owner it was written under

Date: 2026-09-23 · Status: Accepted

## Context

A text conversation is one contact on one of our lines. When it is created it
takes a copy of the line's owner, a user or a department, and every read is
decided by that copy: the inbox, the thread, marking it read, the contacts list,
the unread counter, and who is told that it changed
([decision 0010](0010-the-controller-relays-a-notification-it-does-not-understand.md)).
Who may send is decided separately, from the line's owner as it is now.

Lines change hands. An administrator moves a number from one person to
another, between departments, or between a person and a department, in one
step; or the number goes back to the reserved pool, because its owner was
deleted or it was unassigned, and is later given to somebody else.

The conversation, though, was found by contact and line alone. Once the line
had moved from Alex to Blair, a customer who had texted Alex and texted again
was filed in Alex's old thread: Alex saw the message and its unread badge, and
Blair, who now answers the line, saw nothing. When Blair started a message to
that customer, the send found the same old thread, succeeded, and filed the
message where Blair could not open it; replying to it then answered 404. Alex
could still read the thread and no longer send. The same happened between
departments and after a spell in the reserved pool.

Two readings of "whose is this history" were possible: it follows the line, or
it stays with whoever owned the line when it was written. Following the line
hands one person's conversations to the next, including everything the previous
owner said and was told, the moment an administrator reassigns a number.

## Decision

A conversation's history stays with the user or department that owned the line
when it was written, and the line starts clean for its new owner.

- A conversation is a contact on a line **under one owner**. A new message,
  inbound or outbound, is filed in the thread the line's current owner has with
  that contact, created if they have none. A thread started under a previous
  owner is never picked up by somebody else.
- The previous owner keeps their threads, reads them as before, and can no
  longer send from the line, because sending is decided by the line's current
  owner.
- Somebody who can read an old thread and still sends on the line (a member of
  both the old and the new department) cannot reply in the old thread. The API
  refuses it with `line_reassigned`, and the composer says so before anything
  is typed. They write to the contact from the current owner's thread.
- A new message is filed under the owner its sender was allowed to write as,
  and only if that owner holds the line as the sending transaction reads it. A
  line that changes hands, or is given up, before that read refuses the message
  with `line_reassigned` rather than filing it in the new owner's thread from a
  line its writer no longer holds. A change that commits in the moment between
  that read and the insert is not seen: the message is sent and filed under its
  writer, as the line was read. An inbound message is likewise filed with
  whoever held the line as its transaction read it, and a handover in that
  moment does not turn it away.
- A line given back to a previous owner picks up that owner's own thread again;
  nothing anybody else wrote in between joins it.
- A line nobody holds files nothing. An inbound message to it is quarantined,
  as one to a reserved number already was, rather than stored in a thread
  nobody can see.

In the schema the old unique key on (contact, line) becomes two:
(contact, line, user) and (contact, line, department). A number is held by a
user or by a department, never both, so every thread has exactly one of the two
owner columns set. Postgres leaves a NULL out of a unique index, so each row is
held to the key of the owner it has, and the other key ignores it. Find-or-create
is given the line as the caller's transaction read it and upserts on that
line's owner's key. It does not read the line again, so a message is filed
under the owner its caller checked and never under one it did not.

Nothing that reassigns a number changes. The users, departments and phone
numbers modules keep writing the line's owner and nothing else; messaging reads
it when a message arrives or is sent.

## Consequences

- Existing rows need no backfill. Each already carries the owner it was created
  under, which is what this decision wants, and the old key was stricter than
  the new ones, so no existing data can break them. `prisma db push` still warns
  that unique constraints are being added and asks for `--accept-data-loss`;
  on this change the warning is safe to accept, and the upgrade page says how.
- Existing conversations already stranded by a reassignment sort themselves out:
  the previous owner keeps theirs, and the new owner's first message with that
  contact starts their own thread.
- The same contact on the same line can appear twice for somebody who can see
  two owners' threads (a member of both departments, or somebody who owned the
  line personally and is in the department it moved to). An open thread names
  its owner in the header, and the contacts list adds the owner to the line's
  name when a contact has two threads on it; in the inbox the two look alike.
  Only the current owner's can be written in.
- The realtime notification follows the thread's owner, as before: a message on
  a reassigned line wakes the new owner's browsers and not the previous
  owner's.
- An opt-out stays attached to the contact and the line, not to the owner. A
  customer who replied STOP to the old owner is still opted out when the new
  owner writes, which is also what the carrier enforces on the number.
- A deleted user's threads stay theirs and so are visible to nobody; the same
  holds for a deleted department's. Nothing in the product reads another
  owner's conversations, including an administrator, and this decision does not
  add a way.
- Call history was already per owner. A call row carries the user or department
  it reached when it happened, so a reassigned line neither shows the previous
  owner's calls to an agent who is the new owner, nor hides them from the
  previous owner. One gap remains: a thread shows the calls between its contact
  and its line that the *reader* may see, not only those of the thread's owner,
  so a supervisor or a member of both departments sees both owners' calls in
  each thread. That is a question of the call list's filter, not of whose
  history it is, and is left as it is.
- Two deliveries creating the same thread at once still collide on a unique key.
  The inbound webhook already runs a transaction that lost such a race once
  more, and the collision on either new key is classified as a lost race, not
  as a duplicate delivery. A send does not run again: of two first messages to
  the same contact sent at the same moment, the second fails, as it did under
  the old key.

## Alternatives considered

- **History follows the line.** Rewrite the owner copy on every conversation
  of a number when it is reassigned, or drop the copy and read the owner live.
  Rejected: it hands the previous owner's private conversations to whoever gets
  the number next, which is the opposite of the owner's decision, and the
  rewrite would have to be added to every path that reassigns a number in three
  modules that otherwise know nothing about messaging.
- **Close a line's conversations when it changes hands.** A `closedAt` or an
  ownership epoch on the conversation, set by the reassignment. Rejected for the
  same coupling: every reassignment path, present and future, must remember to
  do it, and forgetting one silently brings the bug back. Keying on the owner
  needs no such cooperation.
- **One owner-key column.** A text column such as `user:<id>` or
  `department:<id>` with a single unique constraint on (contact, line, owner
  key). Rejected: it duplicates what the two owner columns already say, has to
  be kept in step with them, and every existing row would need a backfill
  before the first message after the upgrade.
- **`NULLS NOT DISTINCT`, or partial unique indexes.** A single unique index over
  (contact, line, user, department) that treats NULLs as equal would do it in
  one index. The Prisma schema cannot express it, and `db push` would drop it
  if it were created by hand. A partial unique index (a `where` on `@@unique`)
  is accepted by the schema only behind the `partialIndexes` preview feature
  (checked on Prisma 7.10), and a preview feature can change between releases,
  which a constraint the data depends on should not. The two plain indexes give
  the same guarantee here because a thread always has exactly one owner column
  set.
