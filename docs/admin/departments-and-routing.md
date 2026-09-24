# Departments and routing

For the administrator of a deployment. Covers what a department is, who it rings,
and the settings that decide how an inbound call is handled.

A department owns one or more phone numbers and has members. An inbound call to
one of its numbers rings its members; members can be online or offline, and a
call can go to voicemail when nobody answers.

## Members

**Admin → Departments → the department → Agents** adds and removes members.
Membership is edited here, not from the user's own page, because the order of the
members is part of the department's routing.

Membership also decides who may call out from the department's numbers: the
people a number rings are the people who may use it as caller ID.

## Numbers

**Admin → Phone Numbers** buys numbers from Twilio and assigns them to a user or
a department. A department's **Phone Numbers** tab lists what it owns. Releasing a
number removes it from Twilio and cannot be undone; deleting a department moves
its numbers to the reserved pool.

### When a number changes hands

Text conversations stay with whoever held the number when they happened. Moving
a number to somebody else — another user, another department, between a user
and a department, or out to the reserved pool and later to a new owner — does
not move its conversations with it:

- The new owner starts with a clean line. They do not see the previous owner's
  threads, and a contact who texts the number again, or whom they text, starts a
  new thread that is theirs.
- The previous owner keeps their threads and can read them as before, but can
  no longer send from the number.
- Somebody who can see both, such as a member of the old and the new
  department, sees two threads with the same contact on that number and can
  reply only in the new owner's. Their contacts list names each thread's owner.
- Giving a number back to a previous owner carries on their own threads on it;
  what was written while somebody else had it stays with that somebody.
- A number in the reserved pool receives no texts: a message sent to it while it
  is unassigned is not shown to anybody.
- A contact who opted out of the number (replied STOP) stays opted out whoever
  holds it.

Call history works the same way: each call is kept against the user or
department it reached at the time, and stays visible to them. A thread lists
the calls with its contact on its number that the reader can see, though, not
only its owner's. Supervisors and administrators see every call, so they find
the previous owner's calls with that contact in the new owner's thread, though
not the previous owner's texts. So does somebody who can see both owners'
threads.

The reasons are in
[0011. A line's history stays with the owner it was written under](../decisions/0011-a-lines-history-stays-with-the-owner-it-was-written-under.md).

Each number's Twilio webhooks have to point at this deployment — see
[Twilio configuration](../operate/twilio.md).

## Business hours

The **Business Hours** tab sets, per day of the week, whether the department is
open and between which times. The **Routing** tab carries the timezone they are
interpreted in, and a **24/7** switch that ignores them entirely.

## Routing

The **Routing** tab decides what happens to a call:

- **Open hours**: ring all members at once, or ring them in a fixed order you set.
- **Ring duration**: how long to ring, from 10 to 45 seconds, before falling through to voicemail or the next option.
- **Closed hours**: send to voicemail, or forward to an external number.
- **Voicemail greeting**: what a caller hears before the beep. See [Voicemail greeting](voicemail-greeting.md).

### What a decline does

Declining means "stop ringing me". It never hangs up on the caller:

- **All members at once**: the person who declined stops ringing; everybody else
  keeps ringing. The caller goes to voicemail only once every member who was
  rung has declined or let it ring out.
- **Fixed order**: the decline moves the call on to the next member straight
  away, without waiting out the ring duration. After the last member the caller
  goes to voicemail, exactly as an unanswered ring does.

Declining changes nothing about the member's availability: they are still rung by
the next call. A decline is only accepted from somebody the call is actually
ringing.

A call being handed over is different: if the teammate a
[transfer](../use/softphone.md#transferring) is ringing declines it, the
other party goes back to the agent who started the transfer.

## The routing cache

Routing is answered from a Redis snapshot the API writes, so an inbound webhook
never waits on the database. Changing a department, a phone number or a user
refreshes the snapshot; if the key is missing, the call controller asks the API
directly. The snapshot's lifetime is 24 hours by default
(`DEPARTMENT_CACHE_TTL_SECONDS`).

## Related

- [The softphone](../use/softphone.md) — what a ringing member sees
- [Voicemail greeting](voicemail-greeting.md)
- [0001. Two services, one database](../decisions/0001-two-services-one-database.md) — why routing is cached
