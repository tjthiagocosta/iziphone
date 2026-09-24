# The softphone

For agents. Covers placing a call, taking one, and the controls on a call in
progress.

## Before you can call

The phone registers itself when you sign in, and the browser asks for the
microphone before it does. A coloured dot in the navbar says where it stands:
green "Online - Ready to receive calls", yellow "Connecting...", grey "Offline -
Cannot receive calls". Green needs both the phone and the realtime connection,
so a grey or yellow dot means no call can be placed or received yet.

## Do not disturb

Click the dot to switch **Do not disturb** on or off. While it is on, the dot is
red and no call is offered to you: a call to your own number goes to your
voicemail without ringing, a department call rings your teammates and not you,
and a teammate cannot transfer a call to you. You can still place calls.

It applies to every tab and device you are signed in on, and it stays on until
you switch it off, however many calls you make in between.

## When you are busy

While you are on a call, nobody else can reach you: you are not sent a second
call. A call to your own number goes to your voicemail without ringing, and a
department call rings the teammates who are free. This starts as soon as you
dial out or start ringing for a call, and lasts until that call is over. It
includes the time the call is on hold, and the time you are handing it to a
teammate. There is no call waiting.

## Placing a call

The phone icon in the navbar ("Make a call") opens the dialer: a field to type a
number, a keypad, and recent contacts to dial in one click.

A call leaves from one of your **lines** — your own number, or a number
belonging to a department you are in. The dialer names the line under the number
field, and offers a dropdown when you have more than one. If you have none, it
says so and an administrator has to assign you one. There is no
deployment-wide caller ID: a call naming a line you may not use is refused.

Calling from inside a conversation or from a contact's row uses that thread's
line rather than asking.

## Taking a call

An incoming call fills the screen: who is calling, and two buttons, decline and
answer. When the call is being handed to you by a teammate, the card says
"Transferred by {name}" instead of "Incoming Call".

The call rings every tab and device you have signed in, and the offer clears
everywhere once it is answered or the caller gives up. An unanswered offer
disappears on its own.

Decline means "not me", never "hang up on them". On a call to a department that
rings everybody at once, your teammates keep ringing and the caller only reaches
voicemail once the last of you has declined or let it ring out; on a department
that rings in a fixed order, declining passes the call to the next person
immediately instead of making the caller wait out your ring. Declining does not
take you off the phone: the next call still rings you. See
[Departments and routing](../admin/departments-and-routing.md#what-a-decline-does).

Turning down a call a teammate is handing to you is different: it goes back to
them, and they are told you declined.

## On a call

The call bar sits at the bottom of the screen with a status line and these
controls:

| Control | What it does |
|---|---|
| Mute | Stops sending your microphone. Press again to unmute |
| Hold | Puts the other party on hold with hold music; neither of you can hear the other. Press again to resume |
| Transfer | Hands the call to a teammate |
| Keypad | Sends touch tones, for phone menus |
| End call | Hangs up |

Adding a participant is not available yet.

Hold is confirmed by the server before the bar changes, so a hold that does not
take says so rather than leaving you guessing.

## Transferring

Transfer opens a searchable list of teammates. Teammates who are on a call, in
do not disturb or offline are greyed out with the reason next to their name,
and cannot be picked; the list checks again every few seconds while it is open.
If somebody's status changed just as you picked them, the transfer is refused
and the bar says why.

Pick one and the call goes on hold while they are rung; your bar says
"Transferring to {name}..." and offers **Cancel**, which takes the call back.
You count as on a call until your side of it has hung up, so no other call
reaches you in the moment the teammate takes over.

The teammate sees an ordinary incoming call marked "Transferred by" you. If it
does not land — they decline, do not answer, or cannot be reached — the bar
tells you which, and you still have the call.

Transfer goes to a teammate only. Transferring to a department or to an outside
number, and warm transfer, are not built yet.

## Related

- [Voicemail and recordings](voicemail-and-recordings.md)
- [Departments and routing](../admin/departments-and-routing.md) — what decides who a call rings
