# Users and invites

For the administrator of a deployment. Covers how people get an account, how a
locked-out user gets back in, and what deleting and restoring a user does.

## The one way in

There is no self-registration: the API refuses sign-up, an admin creates users,
and a user chooses their own password through a single-use link — an invite
that lasts 7 days, or a reset that lasts 1 hour. Only the SHA-256 of a link's
token is stored, issuing a new link of the same kind retires the previous one,
and spending one signs every other device out.

Email delivers links but is not the mechanism: the admin console always shows
the link to copy, so the system works before SMTP is configured.

## Inviting somebody

Adding a user invites them. The console shows their link to copy, so onboarding
works before SMTP is configured, and the link is emailed as well when SMTP is
configured. Resending an invite issues a new link and retires the previous one.

New accounts are created with a role; see
[Permissions and roles](permissions-and-roles.md).

## A user who is locked out

A user who is locked out gets a reset link — from the console, or by asking for
one on the sign-in page — and no admin ever sets somebody else's password.
Spending the link signs every other device out, which is also how you get
somebody off a device they no longer have.

Sign-in is by email and password. Users can review and revoke their own active
sessions from the app.

## Deleting and restoring

Deleting a user ends their sessions, removes the password they could return
with and discards any outstanding link. Restoring them issues a fresh invite,
since there is no password left to come back to.

## The first admin

The first administrator is not invited by anyone; it is created by a command on
the server. See [Creating the first admin](../operate/first-admin.md).

## Related

- [Email](../operate/email.md) — the optional SMTP settings
- [Permissions and roles](permissions-and-roles.md)
- [0007. A closed system with invite links](../decisions/0007-closed-system-with-invite-links.md)
