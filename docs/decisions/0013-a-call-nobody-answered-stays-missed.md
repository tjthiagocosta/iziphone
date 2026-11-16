# 0013. A call nobody answered stays missed

Date: 2026-10-02 · Status: Accepted

## Context

A team works the inbox's Missed list to call people back. It lists the calls
whose stored status is `missed` (or Twilio's `no-answer` and `busy`).

The controller published `call:missed` only on the way to voicemail. A caller
who gave up while the call was still ringing took neither of those paths: the
leg's end was reported as `call:ended` with status `completed`, because the
controller answers the caller's leg itself to hold it in the conference, so
Twilio calls it completed after a duration that was all ring time. The call was
stored `completed`, with no agent, and shown as an inbound call that lasted
that long.

A call that did reach voicemail fared no better. Its `call:missed` was stored,
and then the `call:ended` that follows the voicemail wrote `completed` over it,
so it left the Missed list as soon as the call was over.

Call events cross Redis pub/sub: at most once, in no guaranteed order between
channels, and handled concurrently by the API. Whatever the rule is, the stored
result must not depend on which report is handled first, or how often.

## Decision

The controller decides that a call was missed, and the API never lets the end
of the call undo it.

- When the caller's leg of an inbound call ends while nobody has answered it,
  voicemail has not taken it, and nobody is ending it, the controller publishes
  `call:ended` as before, then `call:missed` with `reason: 'caller-hung-up'`.
  Each is sent whatever becomes of the other: the call state is already gone,
  so nothing would retry either one.
  The voicemail paths publish `call:missed` with `reason: 'voicemail'`, as they
  did. A call is reported missed at most once: each report follows the one
  write that sends the call to voicemail or removes its state, which only one
  webhook can make, and a caller who hangs up in voicemail is not reported
  again.
- The API stores `missed` whenever `call:missed` arrives, and writes the status
  of `call:ended` only where the row is not already `missed`, in the same
  statement as the condition. The end still records the duration and the legs,
  in one transaction with its status.
- The timeline gets a `CALL_NO_ANSWER` entry saying why: "no agent answered"
  for voicemail, "the caller hung up before anyone answered", with the caller as
  its actor, otherwise.

The rule lives in the controller because the controller is the only side that
knows, at the moment the caller's leg ends, whether anybody answered and
whether voicemail took the call: both are in the one call state its webhooks
write under a version. It already owned the voicemail half of the rule.

## Consequences

- A caller who hangs up during a department ring (all at once or fixed order),
  a ring of one member's own number, or between two members of a fixed order is
  in the Missed list, however short the ring was.
- A call that went to voicemail now stays missed, so it is in both the Missed
  and the Voicemails lists, and its card is styled as a missed call.
- A call forwarded to an external number out of hours, which the caller leaves
  before that number answers, is missed as well. Its fallback, voicemail when
  the forward is not answered, was already reported missed.
- A call somebody answered is never reported missed, including when a transfer
  that fell through sends the caller to voicemail. A call an agent or the API
  ends while it rings is not missed either: the caller did not give up.
- The timeline still ends with the provider's report of the caller's leg ("Call
  completed after 32s"), now next to the entry that says it was missed. The
  status, not the timeline, is what the inbox reads.
- A lost `call:missed` still leaves the call `completed`, as any lost event
  leaves history short; repeating one adds a second timeline entry, as any
  repeated event does. Neither changes the stored status.
- A `call:missed` without a reason, from a controller that predates the field,
  reads as voicemail, which is all such a controller ever reported.
- A call to a number with no routing goes straight to voicemail and is still not
  reported missed. Nobody owns such a number, so nobody's Missed list would
  show it.
- Calls stored before this change keep the status they were stored with: a
  voicemail left before it stays `completed`, outside the Missed list.

## Alternatives considered

- **The API decides from what it stores**: an inbound call that ends with no
  answer on record is missed. No new field, and no change to the controller.
  Rejected: `call:started` can be lost or handled after `call:ended`, so an
  answered call could be filed as missed, and nothing the API stores says
  whether the caller hung up or somebody ended the call while it rang.
- **Carry the outcome on `call:ended`**, so a missed call needs one event
  instead of two. Rejected: a voicemail call still has its earlier
  `call:missed`, so the API would need the same rule against an overwrite, and
  there would be two ways of saying a call was missed instead of one.
- **A status of its own for a caller who gave up.** It would keep "abandoned"
  apart from "unanswered" in reports. Rejected for now: the Missed list and its
  styling would have to learn it, and the team's use of both is the same, a call
  back. The reason is on the timeline if reports ever need it.
