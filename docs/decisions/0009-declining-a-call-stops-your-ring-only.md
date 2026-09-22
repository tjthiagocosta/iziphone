# 0009. Declining a call stops your ring only

Date: 2026-09-21 · Status: Accepted

## Context

A department rings its members either all at once or in a fixed order, and the
default is all at once. Every member who is online is offered the same call, over
the socket and as a Twilio leg of their own.

Decline was implemented as the opposite of Answer for the whole conversation: the
softphone rejected its Twilio leg and also sent `call_reject`, and the controller
turned that into a hangup of the conversation. On a department that rings
everybody, the first member to decline therefore hung up on the caller — no
voicemail, no chance for a teammate, and the other members' offers vanished from
their screens. On a fixed order it ended the call instead of moving to the next
person.

The same message carried no check that the sender had been offered the call, so
any signed-in user who knew a conversation id could end a ringing call.

A department ring exists so that a call reaches whichever member can take it.
Its fallback, voicemail or a missed call, is for a call that nobody answered,
and a member who is unavailable is skipped in favour of the others rather than
ending the call. A decline that hangs up on the caller contradicts both: it
turns one person's "not me" into "not anyone", and it denies the caller the
fallback they would have reached had that person simply not picked up.

## Decision

A decline means "stop ringing me" and nothing more. The controller hangs up the
legs that are ringing for that user and writes no call state of its own; each
leg's Twilio status callback then does what it already does for a ring that timed
out:

- ringing everybody at once, the other members keep ringing, and the caller is
  sent to voicemail by the last leg to end;
- ringing in a fixed order, the queue advances and the next member is rung at
  once, so a decline saves the caller the rest of the ring duration;
- after the last member, the existing unanswered path: voicemail and a missed
  call.

Declining a pending transfer keeps its own meaning — the other party comes off
hold and back to the agent who started it, and both are told why. An offer that
is stale because somebody has answered stays a no-op.

A decline is honoured only from a user the call is ringing: they hold a pending
agent leg of this call, or they are the pending transfer's target. Anything else
changes nothing and is logged, with the conversation id and the user id and no
phone number, since the numbers in the message would be the caller's and the
sender may have nothing to do with the call.

## Consequences

- One member can no longer cut a department call short for everybody, and a
  conversation id is no longer enough to end a call.
- A call to a single user's own number now goes to voicemail when they decline,
  where it used to be hung up. That is the same path their unanswered ring takes.
- The advance after a decline waits on Twilio's status callback for the hung-up
  leg, as a ring that times out already does. If that callback is lost, the ring
  behaves as it does today when a callback is lost: the caller waits out the
  remaining legs' ring duration. We accept that rather than advancing the queue
  from the decline as well, because `CallState` is read-modify-write with no
  version, and a second writer racing the callback could ring one member twice or
  send the caller to voicemail while somebody is still being rung.
- Several members declining at once means several leg ends close together, each
  updating the call state without a version. That is the same situation a
  simultaneous ring already produces when two legs time out together, since they
  are given the same ring duration, so the decline adds no case the ring did not
  already have. It is one more reason the version belongs there before a second
  instance of the controller is ever run.
- A decline sent in the moment between the offer reaching the softphone and the
  leg being dialed has no leg of this user's to end, so it is refused. The
  softphone covers that window itself: it remembers a decline pressed before the
  device rings and rejects the invite when it arrives. Closing the window in the
  controller instead would mean the decline writing the call state, which is the
  race above.
- Hanging up a call you are already on is unchanged, transfers included; only the
  decline of an offer moved.
- Nothing about availability changed. We have no do-not-disturb or off-duty
  state, so a decline cannot mean "stop ringing me for the next call too". If we
  add one, this record does not decide what a decline should do to it.

## Alternatives considered

- **Keep the hangup, but only for the member who was rung alone.** A one-line
  check, and it fixes the department case. Rejected: it makes a decline mean two
  different things depending on how many teammates happened to be online, and it
  still hangs up on a caller who would otherwise reach voicemail.
- **Advance the ring inside the decline, instead of waiting for the status
  callback.** The next member rings a round-trip earlier. Rejected: it makes the
  decline a second writer of the call state against the callback that is already
  handling the leg, with no version to settle a lost update — the failure it buys
  is worse than the latency it saves.
- **Remove `call_reject` and rely on the softphone rejecting its Twilio leg.**
  Less signalling, and the leg's own end already carries the meaning. Rejected,
  though it is closer than it looks: the softphone already remembers a decline
  pressed before the device rings and applies it to the invite when it arrives,
  which covers the moment before the leg exists. What it cannot cover is a leg
  the device never sees — the socket says the member is there and Twilio's invite
  does not arrive — where only the controller can stop the ring before the ring
  duration runs out. The two together leave the window named in the consequences.
- **Treat a decline as a rejection of the department, and requeue the caller.**
  Closer to a contact centre. Rejected: we have no queue, and it would need
  per-call state we do not keep.
