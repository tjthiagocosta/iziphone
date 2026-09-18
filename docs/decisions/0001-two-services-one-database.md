# 0001. Two services, one database

Date: 2026-09-08 · Status: Accepted

## Context

A phone call is unforgiving about latency: Twilio gives a webhook seconds to
answer with TwiML, and each one is silence for the caller. Business data wants a
relational database, transactions and migrations, and none of that has to be
fast enough for a ringing phone. In one process the two are tied together — a
slow history query, a pool exhausted by an inbox poll, a migration on a lock —
and it is the caller who waits.

## Decision

Two backend services. A **call controller** owns Twilio voice webhooks, TwiML
and call signaling, and holds no database connection at all. A **business API**
owns users, departments, messaging and call history, and is the only service on
Postgres.

Redis connects them: pub/sub for call lifecycle events, a routing cache the API
writes and the controller reads with a 24-hour TTL, and the Socket.IO adapter.
On a cache miss the controller falls back to an HTTP call to the API's
`/internal` routes, behind a bearer `INTERNAL_API_TOKEN` and never exposed to
the internet.

## Consequences

- A webhook never waits on Postgres. The worst case inbound is a Redis read, or the `/internal` fallback on a cold cache.
- Any mutation that changes which user or department a number routes to must invalidate the cache. Left stale it self-heals in 24 hours, far too long to rely on.
- Call history is written from events rather than in the call's own transaction, so the two can disagree if an event is lost.
- Two services to deploy and keep in step, and one shared secret between them.

## Alternatives considered

- **One service.** Simpler to deploy, and the call path would share the API's session and permission code. Rejected so that call handling stays fast and small, and cannot be slowed by anything the business API does.
