# 0016. A number is released only from the reserve

Date: 2026-09-23 · Status: Accepted

## Context

An administrator buys numbers from Twilio, gives each to a user or a
department, moves it between them, and eventually gives it back. Each of those
steps either costs money or ends somebody's calls and texts, and several of
them could not be done safely:

- Releasing was one click from any number, including one a department was
  answering, and it gives the number back to Twilio at once. Twilio holds a
  released number for the account for about ten days, and only its console can
  buy it back, as a new purchase; after that it goes to whoever asks for it.
- A released number kept its row, soft-deleted, because its calls and
  conversations point at it. The number column is unique, so buying the same
  number again paid Twilio and then failed to record it.
- A move wrote the new holder without checking the one it had read, so two
  admins moving the same number at once both succeeded and the last one won
  silently. A department's primary number moved into another department stayed
  primary there, next to that department's own.
- The number was recorded before its webhooks were set, so that a failure
  there would leave a visible number rather than one paid for and forgotten.
  Nothing could set the webhooks again afterwards, and the error read as if
  the purchase had failed, which invites buying a second number.
- A number Twilio no longer had (released in its console, ported away) could
  never be released here: the release asked Twilio first and stopped at its
  "not found".

## Decision

A number has one record for its whole life here, and it leaves only from the
reserve.

- **Held, reserve, released.** A number is held by one user or one department,
  or by nobody (the reserve). Requests name the holder as a single
  `{ type, id }`, or `null` for the reserve, so no request can name two.
- **Release is its own step.** Only a number in the reserve can be released;
  the API refuses any other with a 409, and the admin console offers Release
  only there. Taking a line away from the people who answer it and giving it
  up are two decisions, each with its own confirmation. The release marks the
  number as being released, on the condition that it is still in the reserve,
  before Twilio is asked to cancel it, so nobody can give it to someone,
  change it or buy it back while Twilio works. It stays listed until Twilio
  has let go of it, because a number that may still be billed must stay
  visible: if Twilio refuses, it goes back to the reserve and the refusal is
  audited, and a release that stopped half-way, or that Twilio neither
  confirmed nor refused, is listed as unfinished and finished by releasing it
  again.
- **The reserve keeps billing.** Nothing releases a number on its own, however
  long it sits in the reserve. The confirmations say so.
- **Buying back revives the record.** A number bought again after it was
  released here brings its old row back instead of inserting a second one, so
  its calls and conversations stay attached to it and to the owners they were
  written under ([decision 0011](0011-a-lines-history-stays-with-the-owner-it-was-written-under.md)).
  A number already live here is refused before Twilio is asked to sell it.
- **A move is checked against what the admin saw.** A move or a primary
  change carries the holder the admin's screen showed, and is refused with a
  409 when the number has another one by then. The new holder is also written
  only if the number still has the holder the request read, so of two
  requests landing at once one wins and the other is told. A label change
  depends on no holder and is never refused for this.
- **The primary number follows one rule.** An explicit choice wins. Otherwise
  a number that stays in its department keeps its standing, a number joining a
  department that has no primary becomes it, and a number joining one that has
  a primary does not. Making one primary takes the flag from the others.
- **Setting a number up can be repeated.** A purchase whose webhook setup
  failed is answered as a purchase, marked not connected, rather than as an
  error: the number was bought, and an error would invite buying it again. The
  console says so and points to **Reconnect** on the number's page, which sets
  the webhooks again. Reading the number's details back from Twilio after a
  purchase is best effort; a failure keeps the details the purchase already
  knew.
- **A number Twilio no longer has can still be released.** The release asks
  Twilio to cancel the number and, when Twilio's account does not have it,
  removes it here all the same. The answer says nothing was cancelled at
  Twilio, the console tells the admin where the number may still be billed
  (another Twilio account, or the previous provider for a number that came
  from it), and the audit log notes it.
- **The price is shown before buying.** Twilio's price list for the number's
  type is read with each search and shown in the confirmation, with the fact
  that the first month is billed in full, not prorated. A search whose price
  cannot be read is still answered, and the confirmation says the price is
  unknown.

## Consequences

- Releasing takes two confirmations for a held number. That is deliberate, and
  the row menu and the number's page lead from one to the other.
- A number in the reserve still costs its monthly fee and reaches nobody:
  callers hear that the number is not configured and texts to it are not
  shown to anybody.
- A number bought back comes back under the same id, with no label and with
  whoever the new purchase names as its holder. Conversations and calls from
  its earlier life stay with their owners.
- An admin acting on a number somebody else moved since it was loaded gets a
  409 and reloads. The users and departments modules have their own API paths
  for giving a number in the reserve to someone, with their own primary rule
  and without these checks; they only learned to refuse a number being
  released. The admin console does not use them.
- A department whose primary number is moved away or switched off has no
  primary until an admin chooses another; nothing is promoted on its own.
- A number bought or restored in the Twilio console is not added to the list.
  Importing one is left for later.
- Nothing in the database enforces one holder or one primary per department;
  the rules live in the service and are tested there. There are no migrations
  yet to add such a constraint with.

## Alternatives considered

- **Release from anywhere, with a stronger warning.** One step fewer, and a
  misclick ends a department's line at once, with a new purchase as the only
  way back. Rejected: the two-step path costs a click and removes the worst
  outcome.
- **Release numbers left in the reserve after a while.** Saves forgotten
  fees, and loses a number the business may be printed on. Rejected: giving up
  a number is always an administrator's decision.
- **Hard-delete a released number's row.** Would let the number be bought
  again, and would orphan or delete its calls and conversations. Rejected in
  favour of reviving the row.
- **A version column for the move check.** Also detects a concurrent change,
  but needs a schema change without migrations, and would refuse a label edit
  racing a move. The holder itself is what a move depends on, so it is the
  value compared.
