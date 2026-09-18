# Email

For whoever configures a stack. Covers the optional SMTP settings and what the
system does without them.

Email delivers invite and password reset links, but it is not the mechanism
behind them. With no SMTP server the API still issues every link, and the admin
console shows it to copy, so a deployment works before mail is configured.

Two variables, both or neither:

| Variable | Purpose |
|---|---|
| `SMTP_URL` | Where to send mail, as `smtp://user:pass@host:587` or `smtps://…` |
| `EMAIL_FROM` | The `From` header, e.g. `Phone system <no-reply@example.com>` |

Without these two the API sends no mail and the admin console shows every link
to copy.

Links are built on the first entry of `CORS_ORIGIN`, which is the web app's
origin.

## Related

- [Environment variables](environment.md)
- [Users and invites](../admin/users-and-invites.md) — what the links do
- [0007. A closed system with invite links](../decisions/0007-closed-system-with-invite-links.md)
