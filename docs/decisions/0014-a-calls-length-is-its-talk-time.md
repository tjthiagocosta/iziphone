# 0014. A call's length is its talk time

Date: 2026-10-02 · Status: Accepted

## Context

Call history shows how long each call lasted. The figure came from Twilio:
the `CallDuration` of whichever leg's end the controller handled first.

Twilio reports a leg's end twice, once as a conference participant leaving,
which carries no duration, and once as the leg's call status, which does. The
controller ends the call on the first of the two and ignores the second, so
the same kind of call was stored with its real length or with 0, depending on
which report arrived first.

The figure, when there was one, also meant different things for different
legs. The controller answers the caller's leg itself, to hold it in the
conference, so that leg's duration counts the ring as well as the talk. An
agent's leg on an outgoing call counts its ring too. A call nobody answered
was stored with the whole ring as its length.

## Decision

A call's length is its talk time: from the moment somebody first answered it
until it ended, in whole seconds, time on hold and transfers included.

- An incoming call is answered when the first agent joins it. An outgoing call,
  or one forwarded to an outside number, is answered when that number joins.
  The controller records that moment in the call's state (`answeredAt`), on
  its own clock.
- The call ends when the controller handles the first report of its end,
  whichever of Twilio's two it is. An end found late by the reconciliation
  with Twilio takes the time Twilio says the leg ended instead, since the
  reconciliation may run minutes afterwards. When it finds several legs
  over, the one that ended first ends the call.
- A call nobody answered has a length of 0.
- Twilio's `CallDuration` is no longer used, except for a call answered under
  a controller that did not record the moment, which can only be one still
  going when the controller was upgraded.

Talk time is what the history's "lasted" answers: how long people spoke.
Ringing belongs to a missed call, which decision 0013 already lists apart and
shows without a length, and a voicemail has its own length, its recording's.

## Consequences

- A call has the same length whichever report of its end arrives first.
- A call that went to voicemail without being answered has a length of 0, so
  the inbox row reads "Voicemail" without one. The recording's own length is
  stored with it but not yet shown there. Before, the row showed the ring and
  the voicemail together, or nothing, again depending on the order.
- An answered call that later goes to voicemail, because a transfer did not
  go through, counts the time in voicemail as well.
- The answer and the end can be handled by two controller instances, so a
  difference between their clocks goes into the figure. Instances must keep
  their clocks synchronised, as any server should.
- An end found by reconciliation is timed on Twilio's clock against an answer
  on the controller's.
- A leg Twilio no longer knows at all gives no end time, so an end found that
  way is timed when the reconciliation found it.
- The timeline entry for the end ("Call completed after 27s") carries the same
  figure.

## Alternatives considered

- **The whole call, from the caller's arrival.** Easy to compute from the
  state's `createdAt`. Rejected: an abandoned or unanswered call would show
  its ring as if it had been talked on, and the history would count it as
  such.
- **Wait for the report that carries a duration.** Rejected: the second report
  can be lost, the call cannot stay open waiting for it, and its figure times
  the wrong span for the caller's leg anyway.
- **Redis `TIME` for both moments**, as the call claims use, so that every
  instance reads one clock. Rejected for now: a Redis round trip on every
  answer and every end, for a difference that synchronised clocks keep well
  under a second.
