# 0004. Outbound calls carry a per-call grant

Date: 2026-09-17 · Status: Accepted

## Context

When the browser softphone dials, Twilio sends the call to the TwiML
application's voice URL, and the call controller has to decide who is calling,
whom, and from which line. The obvious source is the webhook's own parameters.

It is not trustworthy. Since the TwiML changelog of 2023-06-01 the Twilio Voice
SDK can override `From`, `To`, `Caller` and `Called` on connect, so
`From=client:<identity>` is whatever the browser chose to send. Anything derived
from it — the caller's identity, and therefore which lines they may use as
caller ID — would be forgeable from the client.

## Decision

The softphone asks the call controller for a single-use grant before dialing:
`POST /api/voice/outbound-grants`, naming the number to call and the line to
call from. The controller checks the line against the routing cache — the people
a number rings are the people who may call from it — and keeps the grant in
Redis for about 60 seconds.

The browser passes the grant as a connect parameter to `device.connect`. When
Twilio's webhook brings it back, the controller consumes it with `GETDEL` and
takes the user, the destination and the line from the grant. A `From` that does
not match the grant is refused as defense in depth.

## Consequences

- The TwiML application's voice URL must be configured with the HTTP POST method; the route accepts nothing else.
- There is no deployment-wide caller ID: a user calls only from a line they own, or a line of a department they are in, and any other is refused.
- The webhook needs nothing the browser could forge.
- A grant is single-use and short-lived, so a dial that stalls over a minute has to ask for a new one.

## Alternatives considered

- **Trust the `From` parameter.** One fewer round trip before every call, and no Redis state. Rejected: the SDK can set it to anything, so it identifies nobody.
