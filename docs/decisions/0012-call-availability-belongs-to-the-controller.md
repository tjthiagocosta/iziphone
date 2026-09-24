# 0012. Call availability belongs to the controller

Date: 2026-09-23 · Status: Accepted

## Context

Until now the only thing the call controller knew about a person was whether
their browser had a socket open. That tells us a browser can hear an offer. It
does not tell us whether the person can take a call. A department ring rang
members who were already on a call. A direct call rang a user whose phone was
busy. A transfer to a teammate on another call rang out as "did not answer",
and their Answer did nothing (issue #1). There was no do not disturb: the web
softphone used to have a switch for it, and we removed it because nothing in
the controller acted on it.

Two calls can reach for the same person at once: a department ring and a
direct call, or a transfer. Each call's state is its own Redis key. If every
change to a call's state is conditional on a version, two writers cannot both
change the same call, but two calls still write two keys, so each passes its
own check. Both can read that a user is free and ring them. Whatever says "this
person is taken" has to belong to the person, not to the call.

A call's state also had races of its own. Every change was a read, a decision
and a write with nothing to stop another change landing in between. Two hold
requests could both publish `call:held`, and two transfers could both start. A
leg registration or a hold could overwrite a decline that had just been
written. Decision [0009](0009-declining-a-call-stops-your-ring-only.md) named
these races and left them for this change.

## Decision

### What callers and agents get

1. A department ring leaves out members who are busy or in do not disturb, as
   it already left out members who were offline. If nobody is left, the
   department's fallback (voicemail and a missed call) runs at once. There is
   no hold queue.
2. A direct call to a user who is busy or in do not disturb takes the path of
   an unanswered call at once, without ringing: voicemail, telling the caller
   the person is unavailable. The caller hears no busy signal.
3. The transfer list shows teammates who are busy, in do not disturb or offline,
   gives the reason, and does not let them be picked. The controller refuses
   such a transfer too, with `target-busy`, `target-dnd` or `target-offline`.
   What the browser shows is only a display and is never trusted. A transfer
   the teammate does not answer still brings the caller back to the agent who
   started it.
4. Do not disturb holds back direct, department and transfer offers. It never
   stops the user from placing calls. The switch is back in the web softphone.
5. No call waiting: a user who is busy is never sent a second invite. A later
   decision may offer it for simultaneous department rings only. Nothing of it
   is built here.
6. A decline keeps the meaning decision 0009 gave it: it stops the decliner's
   ring and nothing else.

Contact-center agent states, per-user call handling options, merging calls,
and round-robin or longest-idle routing are out of scope.

### A version on every call's state

Every `CallState` carries a `version`. Every change to it goes through one
function that reads the state, lets the caller decide the change on that
state, and writes the result with a Lua script. The script writes only if the
stored version is still the one that was read, and increments it. On a conflict
the function pauses briefly, reads again and decides again with the new state,
so a decision never rests on a state that has since changed. A decision that
changes nothing writes nothing.

The function makes at most ten attempts (`CALL_STATE_WRITE_ATTEMPTS`). Every
attempt that loses was beaten by a write that did land, so running out takes
ten writes to one call during a single change. A call can see that many at
once: when one member answers a simultaneous department ring, the others' legs
are hung up together, and Twilio reports each of them within milliseconds, so
a ring of nine members has eight writers at the same moment. The pause between
attempts grows with each one (5 ms times the attempt number) and is jittered,
so writers that collided do not collide again in step. At the cap the change
is abandoned whole: nothing is written, a `CallStateConflictError` is thrown,
and the request that asked for the change fails. A softphone request can be
made again. A Twilio webhook answers 500, and Twilio does not send a status
callback a second time, so what that callback reported is lost until the
controller next asks Twilio about the call (see "Reconciling with Twilio").

### One rule decides availability

`decideAvailability` is a pure function in the controller's `realtime`
module. It takes how many sockets the user has, whether do not disturb is on,
and the calls that currently claim them. It answers `available`, `busy`, `dnd`
or `offline`. `offline` wins over the rest: nobody can ring a user with no
softphone. `dnd` comes before `busy`, because it is the reason that lasts. The
call being offered never makes its own user busy, so offering a call twice
changes nothing. Routing, transfers and the status each softphone receives all
use this rule.

`calls` still does not import `realtime`. It asks for what it needs through
`CallRealtime`, which `app.ts` passes in: offer a call, occupy users for a call
they placed, release users, and renew claims. The answer to an offer,
`CallOffer`, is declared by `calls` beside that interface, and `realtime`
imports the type to implement it. Why a user cannot be offered a call,
`UnavailableReason`, is in `@repo/dto`, because the web shows it too.

### Three facts, kept apart, in Redis only

- **Sockets**: `presence:sockets:*`, as before.
- **Do not disturb and the revision**: `availability:user:{id}`.
- **Claims**: `availability:claims:{id}`.

The controller never touches Postgres, and none of this is written anywhere
else.

### The claim

A claim is one entry in a sorted set per user. The member is the call's
conversation id, and the score is when the claim was last renewed, read from
Redis's own clock (`TIME`) so that no server clock is involved.

An offer claims each user before any leg is dialed. It reads the revision of
every user it considers in one Redis trip, applies the rule to each, and
claims them in parallel, each with a script that succeeds only if the user's
revision is still the one it read. If the revision moved, the offer reads that
user again. After five attempts (`CLAIM_ATTEMPTS`) it takes the user for busy and
logs a warning: a revision that moves that fast means other calls are reaching
for the same user at the same moment. Claiming a call the user already holds
changes nothing. A user who places a call is claimed without the check: they
chose to call.

A claim is released:

- for the members who lost a simultaneous ring, once somebody answers;
- for a member who declines;
- for a member whose ring timed out;
- for a user whose leg failed to dial;
- for a teammate whose transfer did not land;
- for a member whose ring the call never recorded, because the call ended, or
  began to end, while they were being dialed;
- for everybody still on the call when it ends.

Every change to a call releases whoever the change stopped occupying, from the
state before and after it, so no path has to remember to do it. The API's
request to end a call is such a change too. The one claim the state cannot
see is an offer's on a member whose ring it has not recorded yet, since the
offer claims before any leg exists. So whoever made the offer lets go of every
member it claimed whose ring was never recorded, whatever the reason, a throw
included.

A claim expires, so that a release that never happens heals itself. The
controller renews the claims of every call it still has state for once when it
starts and then every 30 seconds (`CLAIM_RENEW_INTERVAL_MS`). A claim not
renewed for 90 seconds (`CLAIM_LIFETIME_MS`) no longer counts. After a lost
release, a user is free again within 90 seconds of their call's state going
away.

The renewal walks the set of live calls (`telephony:calls`), which a call
joins when its state is first written. A call whose state is missing from the
set would never be renewed or reconciled: one already going when the
controller was upgraded to a version that keeps the set, or one whose state
was written and then not added. So the round at start first scans the
call-state keys once and adds whatever is missing, and every round tries
again until that scan succeeds. A user who places a call is claimed just
before its state is written, so that no offer can land in between, and is let
go again if the write fails.

The call's state, not the claim, is what says who a live call occupies. A
renewal claims the call's current occupants whether or not their claim still
stands. After the controller or Redis was away for longer than a claim lasts,
every claim has run out while the calls went on, and the first round (the one
at start) claims those users again, moves their revision on and tells them
they are busy. A renewal that crosses a change which let somebody go would
claim them back, so after renewing it reads the call's version again, and if
the call changed meanwhile it releases whoever that change let go.

### Reconciling with Twilio

Twilio does not send a status callback twice. A call whose last callback was
lost (the controller was restarting, or the write gave up) keeps its state,
and so keeps its people busy, until the state's TTL of four hours runs out.
So every tenth renewal round (`RECONCILE_EVERY_ROUNDS`, about every five
minutes), and the round at start, also starts a reconciliation, which asks
Twilio for the status of every leg of every live call.

The reconciliation is a task of its own. The round starts it once every call
has been renewed and does not wait for it, and no second one starts while one
is running. The rounds go on renewing every 30 seconds whatever it is doing,
so a Twilio that is slow or unreachable never delays or skips a renewal. That
matters most on the round at start, which claims back whatever ran out while
the controller was down. The reconciliation asks about four calls at a time
(`RECONCILE_CONCURRENCY`) and gives up on a leg Twilio has not answered for
within five seconds (`LEG_STATUS_TIMEOUT_MS`), so it ends even when Twilio does
not answer. A failure for one call is logged and skips only that call, which
the next reconciliation asks about again.

A leg Twilio reports over, or no longer knows, is handled exactly as its lost
status callback would have been: a call nobody is left on ends and lets its
users go, and a lost ring moves the ring on. A leg's end can be reported more
than once, by the conference, by its status callback and by a reconciliation,
and two reports can each read the leg as still there. Only the report whose
write takes the leg out of the call tells the API, so the timeline records it
once.

The controller may run as more than one instance, and each renews every call.
Reconciling is not repeated per instance: a reconciliation first takes a
Redis lock (`telephony:reconcile`, `SET NX PX`) and keeps it for nine rounds,
one short of the time to the next, so that its holder finds it lapsed when
that comes. An instance that finds it taken stays due and tries again every
round until it lapses. An instance that stops gives the lock up, so the one
that starts next reconciles at once. The cost is one Twilio request per leg of
every live call every five minutes, however many instances run.

### What occupies a user

- an inbound call they answered, including while it is on hold;
- a call they dialled, from the moment it is placed;
- every member a simultaneous department ring is ringing, until somebody
  answers;
- in a fixed-order ring, the member being rung now;
- both the agent and the teammate while a transfer is ringing that teammate;
- the agent who handed a call over to a teammate, until their leg has left the
  conference.

A call that is ending keeps each of these until their own leg drops. Ending
takes nobody back: a member whose ring lost to the answer, and whose leg is
still being hung up, stays let go. A call that went to voicemail occupies
nobody. An outbound call whose agent
leaves before the number answers ends, and the number stops ringing.

### Do not disturb

Do not disturb is live state in Redis, not a saved preference. It belongs to
the user rather than to a device, so it applies to every softphone they have
open, and it lasts until they switch it off, however many calls come and go.
If Redis is flushed it is lost, and everybody's do not disturb is off again,
exactly as every live call is lost. The softphone switches it with
`PUT /api/voice/availability/me/do-not-disturb`.

### The revision and the events

Each user has one revision. It grows with every change to their claims or do
not disturb, inside the same script that makes the change, and every time one
of their softphones registers or goes away, so an offer decided on the
connection as it was takes nothing. When a change alters a user's
availability, the controller sends `user_availability`
(`userId`, `state`, `revision`) to that user's own sockets and to nobody else.
The event carries nothing about the call. A softphone keeps the highest
revision it has applied and ignores anything older. Redis pub/sub replays
nothing, so a softphone also reads a snapshot (`GET /api/voice/availability/me`)
every time its socket connects. The transfer list reads
`GET /api/voice/availability?userIds=` when it opens, and every ten seconds
while it stays open.

The user's hash also keeps `availableSince`: the moment they last became free
to be offered a call. It is written each time the controller announces the
user's availability, which is on every change to their claims, do not disturb
or connection. It stays put while they remain free, is cleared while they
cannot be offered a call (offline included), and the revision guards it so
that a late write cannot move it. A user nothing has been announced for since
the last Redis flush has none. Nothing uses it yet. It is kept for a future
longest-idle routing.

## Consequences

- Issue #1 is closed: a transfer to a teammate on a call is refused before
  anything rings, and the list says why.
- Nobody is sent two calls at once. A department whose members are all taken
  sends the caller to voicemail straight away, where it used to ring people
  who could not answer.
- A call's state cannot be overwritten by a change decided on an older copy.
  The double hold, the double transfer, and a leg registration or hold
  racing a decline each settle to one outcome.
- A call whose end Twilio never reports keeps its people busy until the next
  reconciliation, about five minutes at most, or at once after a restart. A
  controller that died without giving the reconcile lock up delays the one
  after the restart by up to four and a half minutes. It used to take the
  state's four-hour TTL, and before this decision a stale state kept nobody
  from being called at all.
- An outage longer than a claim lasts no longer frees the users still on
  calls for the rest of those calls: the round at start claims them again.
- Offering a call costs two Redis trips for everybody it considers (their
  records, their sockets), one claim per user in parallel and, when their
  availability changed, an announcement. The dial does not wait for the
  announcement, which reads the users' state when it goes out.
- A call already in progress when the controller is upgraded to this version
  is found by the round at start and its users are claimed again.
- A softphone registering or going away moves the revision and is announced
  to the user's other softphones. A presence entry that lapses without a
  disconnect (a controller that stopped with the socket still open) moves
  nothing and is not announced. Offers read the sockets anyway, and the
  transfer list polls.
- A claim that lapses without a release sends no event, so a softphone can
  show "busy" until the next change or reconnect. The controller has already
  let that user be offered calls.
- `availableSince` is not refreshed when a claim lapses without a release or
  when a presence entry lapses without a disconnect, because neither is
  announced. A user freed that way keeps the moment of the last change that
  was announced, or has none. A routing built on it must accept that or
  announce those paths too. Keeping it costs one Redis call per announced
  user on every announcement.
- A decline writes no state (decision 0009), so the call still rings the
  member who declined until Twilio reports their leg gone, usually within a
  second. A renewal in that moment claims them again, and the leg's report
  lets them go. If the report is lost, the next reconciliation does.
- A Redis flush starts revisions again from zero. A softphone that stays
  connected ignores the events until its next reconnect reads a fresh
  snapshot. The answer to the user's own do not disturb switch is applied
  whatever its revision, because nothing the softphone knows is newer. The
  controller's decisions are not affected.
- The wire shapes of the event and the availability routes live in
  `@repo/dto`, next to the other socket events, and the Redis keys in
  `@repo/events`. The dto package cannot import from events, which already
  depends on it. The call-state keys (`telephony:call:`, `telephony:calls`,
  `telephony:leg:`), which the controller used to spell out itself, moved to
  `@repo/events` too.

## Alternatives considered

- **Socket connectivity as availability.** It is what we had: no new state,
  nothing to keep in step. Rejected because a connected socket says the
  browser can hear an offer, not that its user is free. It rang people on
  calls, and it let a transfer ring someone whose Answer could not work.
- **Availability in the API's database.** Do not disturb would outlive a Redis
  flush, and could carry history. Rejected because the controller never touches
  Postgres, and it decides availability on every offer, during a webhook. It
  would have to ask the API each time, or read a cache, and a cache cannot be
  the lock two calls race for. Claims change several times in every call,
  which is state the controller already keeps in Redis.
- **Only a per-call version.** It settles every race inside one call, and it is
  part of this decision for that reason. Rejected as the whole answer: two
  calls are two keys, so both pass their checks and ring the same free user.
  Only a claim that belongs to the user stops that.
- **Always sending the second call, and letting the user choose.** That is
  call waiting. Rejected for now: the softphone handles one call at a time.
  Taking a second would mean holding and swapping calls, which the softphone
  cannot do, and an Answer that does nothing is the bug this fixes. A later
  decision may allow it for simultaneous rings only.
