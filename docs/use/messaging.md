# Messaging

For agents. Covers the inbox, how a message reaches you, sending a text, and
what the composer tells you when it will not let you send.

## The inbox

The inbox is one list, newest first, of everything that happened on the lines
you can see: text conversations and calls together. Each row names the contact,
the line it was on, and a preview. Tabs narrow it: **All, Unread, Calls, Missed,
Voicemails, Messages**. "Show older" pages further back.

A message row opens the thread. A call row offers **Call back** instead, from
the line the call was on.

Not every sender is a person with a phone number. Delivery notices, one-time
codes and alerts arrive from a short code such as 55501, or from a name such as
EXAMPLECO. They land in the inbox as their own threads, named by whatever the
carrier sent. A short code can be answered; a name cannot, and the thread says
so instead of offering a composer. Neither can be called, so the call button on
those threads and contacts says there is no number to call.

Conversations are per line: the same person messaging two of your numbers is two
threads, each labelled with its line. Text conversations on a number are shared
with everyone who works that line, so a teammate can pick up where you left off.
A department page shows the same inbox scoped to that department's line.

When an administrator gives a number to somebody else, its conversations stay
with whoever had it. You keep reading the threads from your time on the number
but can no longer send from it; the new owner starts with none of them, and
anything the contact sends afterwards goes to the new owner.

## When a message arrives

A message shows up on its own; you do not have to reload. A sound plays, and the
browser tab counts the conversations you have not read yet — `(3) iziphone -
Business Phone System` — so you can see there is something waiting while you are
on another tab or in another window. The count is everything you can see,
whichever tab or line the inbox is filtered to, and it goes back to the plain
title once you have read them all. On a line several of you work, a teammate
reading a conversation clears it for everybody, but your tab catches up only
when the next message arrives or an open inbox next refreshes itself, which is
within a couple of minutes.

The thread you are reading makes no sound: the message appears in front of you
instead. Nothing sounds for a message of your own being delivered, and a run of
messages arriving together is one sound rather than a string of them.

Browsers refuse to play a sound on a page nobody has clicked yet, so a tab you
opened and left alone stays silent until the first time you use it. The tab
count still tells you.

## Sending

Replying in a thread always sends from that thread's line — there is no sender to
choose. **New message** asks for the line to send from (only numbers that can
send texts are listed) and who to send to, by name or by full number.

Messages can be up to 1600 characters. Enter sends, Shift+Enter starts a new
line.

Received MMS attachments are listed under the message they came with. Sending an
attachment is not available in the app yet.

## When you cannot send

The composer is disabled with the reason above it:

- "This sender cannot receive replies." — the thread is with a service that texts from a name rather than a number, and the carrier has no address to send an answer to. The messages are kept; nothing can go back.
- "This contact has opted out of messages from this number." — they replied STOP. Nothing more can be sent to them from this line.
- "You cannot send from the number this conversation is on." — the line is not one of yours.
- "This number has changed hands since this conversation. Start a new message to write from it." — the number moved to somebody else since this thread, for example from one of your departments to another. The thread stays readable; write to the contact with **New message** from the number, which goes to its current owner's thread.
- "This number cannot send text messages." — the line has no SMS capability.

A message the provider rejected appears in the thread in red with the reason, so
you can see it did not go out rather than assuming it did.

## Contacts

**Contacts** lists everyone you have called or messaged, searchable by name or
number, with a chip per conversation line and a call button. Contacts are created
by calling or messaging somebody; there is no form to add one.

## Related

- [The softphone](softphone.md)
- [Permissions and roles](../admin/permissions-and-roles.md)
