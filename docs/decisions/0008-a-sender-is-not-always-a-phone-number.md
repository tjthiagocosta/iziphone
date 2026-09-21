# 0008. A sender is not always a phone number

Date: 2026-09-20 · Status: Accepted

## Context

Twilio puts three different things in the `From` field of an inbound message: a
phone number, a short code of three to seven digits, or an alphanumeric sender
id of up to eleven characters, which is how services outside North America
identify themselves. Delivery notices, one-time codes and appointment reminders
routinely arrive as the last two.

The inbound webhook required every sender to normalise to E.164. Anything else
failed validation, the webhook answered 400, and Twilio does not retry a 4xx, so
those messages were never stored and nobody could see that one had arrived.

Accepting them raises a second question, because a reply behaves differently for
each kind: a number and a short code can be written to, a name cannot — there is
no address for the carrier to route an answer to.

## Decision

An inbound sender is classified once, in `toMessageAddress` in `@repo/dto`, as a
phone number, a short code or a sender id. A number is stored in E.164 as
before; the other two are stored exactly as the provider sent them, and the
value is refused at the boundary only when it is empty or longer than 64
characters, which no provider address is.

Those senders become ordinary contacts and ordinary threads: the inbox, the
thread and the contacts list show them under whatever the carrier sent, and no
response schema demands E.164 for a contact's number.

A reply is allowed to a number and to a short code. A thread with a sender id
shows no composer and says the sender cannot receive replies, and the API refuses
such a send with a 400 rather than paying the provider to reject it. Starting a
new thread still requires a dialable number: there is nothing to type that would
reach a sender id, and the new-message search offers only the threads a number
addresses, because the number picked there is what decides which thread the
message joins. A short code is answered in its own thread instead.

## Consequences

- A one-time code or a delivery notice is now visible in the inbox instead of being silently dropped.
- `Contact.phoneNumber` no longer holds only phone numbers. Anything that assumes E.164 for the other party in a message is wrong; the API's own numbers are unaffected and stay strict.
- Contact search matches these senders by digits, so a short code is found by typing it. A sender id is only found by browsing, since search matches names and digits.
- A thread that cannot be answered is now a state the composer has to render, and the docs name the sentence it shows.
- Calling such a contact is refused in the same way, because the button sits next to a thread that has no number behind it. Which line a call leaves from and whether there is anything to call are two separate rules, and the second one now narrows the first wherever the destination is a contact.

## Alternatives considered

- **Keep rejecting them.** No code to write, and no contact rows of a new shape. Rejected: the message is lost with no trace, which is the failure we set out to fix, and a customer's one-time code is exactly the message they notice missing.
- **Store them but hide them from the inbox.** Avoids the unanswerable thread. Rejected: an invisible message is barely better than a dropped one, and the reader is the one who should decide whether a delivery notice matters.
- **A separate table for senders that are not numbers.** Keeps `contacts` honest to its name. Rejected: it duplicates conversations, threads and the inbox query for a difference that only affects whether a reply can leave, which one classifier answers.
