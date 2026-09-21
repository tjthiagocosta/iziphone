# Messaging

For agents. Covers the inbox, sending a text, and what the composer tells you
when it will not let you send.

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
