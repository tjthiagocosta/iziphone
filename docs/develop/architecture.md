# Architecture

For developers. Explains the two backend services, what Redis carries between
them, and the two rules the design depends on. Ends with the tech stack as a
reference table.

```
                     ┌──────────────────────────┐
                     │        apps/web           │
                     │  Next.js + Twilio Voice   │
                     └──────┬─────────────┬──────┘
               HTTP (cookie)│             │ Socket.IO (JWT)
                            ▼             ▼
                 ┌────────────────┐   ┌─────────────────────┐
                 │   apps/api     │   │ apps/call-controller│◄──── Twilio voice
                 │  Fastify 5     │   │     Fastify 5       │      webhooks
                 │  Prisma 7      │   │  no database access │
                 └───┬────────┬───┘   └──────────┬──────────┘
      Twilio         │        │                  │
      messaging ─────┘        │  Redis pub/sub   │
      webhooks                │  + routing cache │
                              ▼                  ▼
                     ┌────────────────┐  ┌───────────────┐
                     │  PostgreSQL 18 │  │    Redis 8    │ 
                     └────────────────┘  └───────────────┘
```

**Three services, one database.** The web app talks to the API over HTTP with a
session cookie. The API owns the database and all business logic. The call
controller handles everything time-sensitive on a live call and never touches
the database.

**A closed system with links as the way in.** There is no self-registration:
the API refuses sign-up, an admin creates users, and a user chooses their own
password through a single-use link. Email delivers links but is not the
mechanism. See [Users and invites](../admin/users-and-invites.md) for what that
looks like in use, and
[0007. A closed system with invite links](../decisions/0007-closed-system-with-invite-links.md)
for why.

**Media lives in an S3-compatible bucket.** MMS attachments, voicemail
greetings and call recordings are written to and read from object storage by
the API alone (`apps/api/src/media-store`), and served to browsers and to
Twilio through the API's own routes, so the bucket stays private. Twilio makes
the recordings; as soon as it reports one complete, the API copies the file
into the bucket, records it on the call and deletes it at Twilio, so playback
and retention depend on your bucket, not on Twilio's storage. While a copy is
still owed (Twilio not ready yet, the bucket down), playback fetches from
Twilio and completes the copy on the way. Any provider that speaks the S3 API
works; see [Object storage](../operate/object-storage.md).

**The call controller reads routing from Redis.** When an admin changes a
department, a phone number, or a user, the API writes a routing snapshot to
Redis (keys under `routing:phone:*`). Inbound webhooks resolve the destination
from that cache. If a key is missing, the controller falls back to an HTTP call
to the API's internal routes.

**Call events flow through Redis pub/sub.** The call controller publishes call
lifecycle events and the API subscribes to persist them. Channel names live in
`packages/events`:

| Channel | Published by | Meaning |
|---|---|---|
| `call:incoming` | call-controller | Inbound call received |
| `call:started` | call-controller | Call answered / conference joined |
| `call:ended` | call-controller | Call finished |
| `call:missed` | call-controller | Nobody answered |
| `call:transferred` | call-controller | Transfer completed |
| `call:held`, `call:resumed` | call-controller | The other party was put on hold, or taken off it |
| `call:participant-status` | call-controller | Participant joined, left, muted, held |
| `call:recording-ready` | call-controller | Recording available |
| `call:transcription-ready` | call-controller | Transcript available |
| `call:conversation-migrated` | call-controller | Call SID changed mid-call |
| `call:hangup` | api | Command sent to the call controller |
| `message:activity` | api | Notification relayed to the browsers |

**A notification is neither an event nor a command.** `message:activity` is the
third group of channels: the API publishes it, and the call controller relays it
to browsers without acting on it. When an inbound message is stored, or a
delivery status changes, the API resolves who may see that conversation — the
user whose line it is, plus the members of the department whose line it is — and
publishes the conversation id, what happened (`received` or `status`), and those
user ids. The controller turns the ids into socket ids through presence and
emits `message_activity` with the conversation id and the kind; the browser then
fetches the conversation and its messages from the API as it always has.

The payload carries ids and nothing else — no body, no phone number, no message
id. That is what keeps the controller out of messaging: it cannot read anything
about a message, it stores nothing, and the rule about who may open a
conversation stays in the API, on the fetch the browser makes anyway. A publish
that fails is logged and dropped, because the message is stored and the
browser's poll still finds it. See
[decision 0010](../decisions/0010-the-controller-relays-a-notification-it-does-not-understand.md).

Hold and transfer are not commands. The softphone asks the call controller for
them directly (`POST /api/voice/calls/:legUuid/hold`, `/transfer` and
`/transfer/cancel`, with the realtime JWT), because only the controller can
check the request against the live call and answer with what happened. How a
transfer ended reaches the softphones as the `call_transfer_outcome` socket
event.

An outbound call starts the same way: the softphone asks
`POST /api/voice/outbound-grants` for a grant to call a number from one of the
user's lines, and dials through Twilio with the grant alone. The controller
checks the line against the routing cache (the people a number rings are the
people who may call from it), keeps the grant in Redis for a minute
(`voice:outbound-grant:*`), and consumes it when Twilio's webhook brings it
back, so the webhook needs nothing the browser could forge.

**Conference-first calling.** Inbound and outbound calls are placed into a
Twilio conference from the start. The controller keeps per-call state in Redis
(`telephony:call:*`, `telephony:leg:*`, `call:participants:*`) with TTLs of one
to four hours so abandoned state cleans itself up. Hold, transfer and
supervisor features all work by adding, removing or updating conference
participants instead of re-dialing.

**Realtime to the browser.** The call controller runs Socket.IO with the Redis
adapter, so it can scale horizontally. Users authenticate to the socket with a
short-lived JWT issued by the API. Each user's sockets are tracked in Redis
(`presence:sockets:*`) so an inbound call can ring every tab and device that
user has open, and so a message arriving on a line reaches everybody who works
it.

**Availability.** A socket says a browser is reachable, not that its user can
take a call. The controller also keeps each user's do not disturb and the calls
that claim them (`availability:user:*`, `availability:claims:*`), and one pure
rule turns the three into available, busy, do not disturb or offline. An offer
claims each user before dialing, so two calls cannot ring the same free person;
claims are renewed at start and every 30 seconds for every call still going
(`telephony:calls`), claimed again if they ran out while the call went on, and
lapse after 90 seconds unrenewed. The round at start also adds to that set any
call whose state is missing from it, such as one already going when the
controller was upgraded. At start and about every five minutes the renewal
also starts a reconciliation, which it does not wait for, so a slow Twilio
never holds a renewal up: it asks Twilio about every leg of those calls, four
calls at a time and for at most five seconds a leg, and handles a leg that is
over as its lost status callback would have been, so a call whose end was
never reported does not keep its people busy. With several controller
instances, a Redis lock (`telephony:reconcile`) has one of them do it per
period. A user's softphones hear
`user_availability` when theirs changes, including when one of them connects
or goes away. Every change to a call's state is a conditional write on its
`version`. The call-state keys (`telephony:call:*`, `telephony:calls`,
`telephony:leg:*`, `telephony:reconcile`) are declared in `@repo/events` with
the other Redis keys.
See [0012](../decisions/0012-call-availability-belongs-to-the-controller.md).

**Browser softphone behavior.** The web app registers a Twilio Voice device on
sign-in and refreshes its token before it expires. Microphone access is
requested before the device registers.

## The two rules

- The call controller never touches Postgres. It reads routing from the Redis cache the API writes, with an HTTP fallback to the API's `/internal` routes.
- Only the API talks to object storage. The call controller has no bucket credentials.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | [Node.js](https://nodejs.org) 24 LTS |
| Package manager | [pnpm](https://pnpm.io) 12 |
| Monorepo | [Turborepo](https://turbo.build) 2, pnpm workspaces |
| Web app | [Next.js](https://nextjs.org) 16 (App Router), React 19, Tailwind CSS 4, [shadcn/ui](https://ui.shadcn.com) |
| Browser telephony | [@twilio/voice-sdk](https://www.twilio.com/docs/voice/sdks/javascript) 2 |
| API and call controller | [Fastify](https://fastify.dev) 5 |
| Authentication | [Better Auth](https://www.better-auth.com) 1.7 (cookie sessions, HS256 JWT for the call controller) |
| Database | PostgreSQL 18 via [Prisma](https://www.prisma.io) 7 |
| Cache, pub/sub, routing state | Redis 8 via ioredis 6 |
| Media storage | Any S3-compatible bucket via `@aws-sdk/client-s3` 3 (MinIO in development) |
| Realtime | [Socket.IO](https://socket.io) 4 with the Redis adapter |
| Telephony backend | [Twilio](https://www.twilio.com) Programmable Voice and Messaging (Node SDK 6) |
| Validation | [Zod](https://zod.dev) 4 |
| Lint and format | [Biome](https://biomejs.dev) 2 |
| Tests | [Vitest](https://vitest.dev) 5 |
| Language | TypeScript 7, strict, ESM |

## Related

- [Project structure](project-structure.md)
- [0001. Two services, one database](../decisions/0001-two-services-one-database.md)
- [0002. Object storage behind one interface](../decisions/0002-object-storage-behind-one-interface.md)
