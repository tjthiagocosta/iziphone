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
