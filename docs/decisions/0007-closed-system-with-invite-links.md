# 0007. A closed system with invite links

Date: 2026-09-18 · Status: Accepted

## Context

A deployment is one company's phone system on that company's own Twilio account,
and anyone holding an account in it can place calls the customer pays for. That
makes an open registration form on a reachable host the wrong default: it hands
a stranger the customer's Twilio balance.

Passwords also have to arrive somehow. An admin typing one for somebody else
means the admin knows it, and a system that needs SMTP before anyone can sign in
cannot be brought up at all.

## Decision

There is no self-registration. An admin invites people, and a single-use expiring
set-password link is the one mechanism behind both invites and password resets: 7
days for an invite, 1 hour for a reset. Consuming a link sets the password,
revokes every other session and signs the user in; resending rotates it.

The admin console always shows the link to copy, so email (`SMTP_URL` and
`EMAIL_FROM`, optional) is a delivery channel and not the mechanism. The first
admin comes from the `bootstrap-admin` command, which prints an invite link and
refuses to run once the deployment has an administrator. Deleting a user revokes
their sessions and their credential; restoring them issues a new invite, because
there is no password left to come back to.

## Consequences

- Admins create everyone. There is no path into a deployment that does not go through one.
- Forgot-password always answers the same way, whether or not the address exists, and sits behind the sign-in rate limit.
- A deployment works before SMTP is configured, and a broken mail server locks nobody out permanently.
- One mechanism to get right instead of two, and no password ever travels from an admin to a user.

## Alternatives considered

- **Open sign-up behind an environment flag.** Simple, and the flag could be closed after the first admin. Rejected: it leaves a registration form on a reachable host, and a flag left open is invisible until somebody uses it.
- **Email verification on top of accounts.** Standard, but redundant: the invite link already proves the person reads that mailbox, and it would add a hard dependency on SMTP.
