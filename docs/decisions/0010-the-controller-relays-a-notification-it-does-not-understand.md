# 0010. The controller relays a notification it does not understand

Date: 2026-09-22 · Status: Accepted

## Context

An inbound text is in the database within a second of arriving, but it reached
the agent only when the browser next asked: the inbox every 30 seconds, an open
thread every 20, and both only while the tab was visible. With the tab in the
background nothing told the agent that a customer had replied. Those intervals
were not arbitrary — the API allows 100 requests a minute per client address and
an office usually shares one, so the polls were set as fast as that budget
allowed and no faster.

The browser already holds a Socket.IO connection to the call controller, which
it needs for calls: authenticated with the realtime JWT the API issues, tracked
in presence so a call can ring every tab a user has open, and reconnecting on
its own. That connection is idle between calls.

The obstacle is not the transport but the ownership. Messaging belongs to the
API: the database, the conversations, the contacts, and the rule about who may
read a conversation (the user whose line it is, or a member of the department
whose line it is). The call controller owns telephony, has no database, and by
[decision 0001](0001-two-services-one-database.md) must keep it that way. A push
that made the controller a messaging participant would put message content and
an authorization decision in the one service that is meant to hold neither.

## Decision

The API publishes a notification on a Redis channel, `message:activity`, and the
call controller relays it to browsers without understanding it.

This is a third group of channels in `packages/events`, beside the call events
the controller publishes for the API and the commands the API sends the
controller. A notification asks the controller for nothing; it is addressed
through it.

The payload carries ids only: the conversation id, whether a message was
`received` or a delivery `status` changed, and the ids of the users who may see
that conversation. No body, no phone number, no message id, no contact. The API
resolves the audience itself, from the same ownership the inbox filter reads.
The controller resolves those user ids to socket ids through presence and emits
`message_activity` with the conversation id and the kind. The browser then
fetches the conversation and its messages from the API, exactly as it did on the
poll, and the API decides there whether this reader may have them.

So a notification tells the controller who to wake and nothing about why. It
learns no message content, stores nothing, and remains a service that could be
run by somebody who is not allowed to read the messages it relays.

Polling stays as the safety net for a notification that is lost, and relaxes
now that it is no longer how a message arrives: the inbox every 120 seconds, an
open thread every 60. A burst of notifications within about half a second is one
fetch, so a contact sending four messages costs one read rather than four.

A publish that fails is logged at warn, with ids, and the webhook still answers
the provider 2xx. The message is stored; the poll will find it.

## Consequences

- An inbound message reaches every agent who works that line within about a
  second, over a connection that was already open and already authenticated. No
  second transport, no second auth path, no second reconnection story.
- Only a tab the agent is looking at fetches on a notification. A hidden one
  remembers that it was told and reads the moment it is shown, which is what it
  did on returning before, and what keeps the longer intervals honest.
- Message polling drops from about 3 requests a minute for an open thread to 1,
  and from 4 for an inbox listing both calls and conversations to 1. Ten agents
  with a thread open spend 10 requests a minute of the shared budget where they
  spent 30, which leaves more of it for the requests people make by working.
- What the polls no longer spend, traffic now does: each notification costs the
  visible tabs in the audience one read each, so a busy line is dearer than it
  was and an idle one much cheaper. A burst is one read, a background tab is
  none, and a read caused by a notification asks only for the list that can have
  changed, which is what keeps the busy case inside the budget. A line busy
  enough to overrun it would be the reason to give the notification a payload
  the browser can render, and that is a different decision.
- Only the two places that already write on somebody else's behalf publish: an
  inbound message and a delivery status the carrier reported. A colleague
  sending on a line you share is therefore not what wakes your browser; the
  carrier's report on that message, usually seconds later, is. Where no report
  ever comes — a send refused before it reached the carrier, a carrier that
  stops at "sent" — their message reaches you on the interval instead, which is
  now a minute rather than twenty seconds. The same holds for one agent reading
  a conversation on a line several people work: the others see it stop being
  unread on their next poll, which is slower than it was. Publishing from those
  paths as well is the obvious next step if either wait is felt; it needs no new
  kind, because the browser acts on the conversation id and not on why it was
  woken.
- The notification is a hint, never the data. Nothing in the browser renders
  from it, so a notification that is delayed, lost or duplicated costs a wait or
  a redundant fetch and cannot show one reader another's messages.
- Redis pub/sub is at-most-once and has no replay. A controller restart or a
  dropped socket loses notifications silently, which is why the polls stay.
- The audience is resolved when the notification is published, from the
  ownership copy on the conversation. A number reassigned between then and the
  fetch changes who the API will serve, not who was woken: somebody woken for a
  conversation they have since lost gets a 404 on the fetch and shows nothing.
- The controller now subscribes to a channel whose payload it must not extend.
  Adding a field with message content to `MessageActivityNotification` would
  quietly undo this record; the schema says so, and the relay copies the payload
  through rather than rebuilding it.
- One more thing to keep in step: a new reason a conversation changes (a message
  deleted, a conversation reassigned) needs a `kind` and a publish, or the
  browser only sees it on the next poll.

## Alternatives considered

- **Server-sent events from the API.** The API owns the data and the
  authorization, so a stream straight from it is the shortest line between the
  two. Rejected: it duplicates three things the socket already has — a
  connection per browser, a way to authenticate it, and reconnection with
  backoff — and adds a second long-lived connection per tab for the API to hold
  open, for a message that is a fraction of what the existing one carries. The
  cost of the socket detour is one Redis publish and a payload of ids.
- **Publish the message itself and let the controller push it.** The browser
  would need no fetch at all. Rejected outright: it puts message bodies and
  phone numbers through the service that is meant to know nothing about them,
  and it moves the "may this reader see this" decision to a place with no
  database to answer it.
- **Have the API push to the socket through the Socket.IO Redis adapter.** The
  adapter is already there and the API could emit into it directly. Rejected: it
  makes the socket's protocol and room layout a shared surface between both
  services, so a change in how the controller tracks sockets breaks the API. The
  channel keeps the contract to a schema in `packages/events`.
- **Poll faster.** No new mechanism at all. Rejected: the budget is the reason
  the intervals are what they are, an office behind one address would exhaust it
  with a handful of agents, and a hidden tab must not poll at all, which is
  exactly the case that needed fixing.
- **Web Push, so an agent hears about a message with the app closed.** Rejected
  for now as a different feature: it needs a service worker, a subscription per
  device, VAPID keys and a decision about what a notification may say outside
  the app. This record covers the open app only.
