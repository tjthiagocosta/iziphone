# Creating the first admin

For whoever brings up a new deployment. Covers the one command that creates the
first administrator, and how everybody else gets in afterwards.

There is no sign-up: every deployment is a closed system, and people get in
through an invite link an admin issues. The first admin is created by one
command, which refuses to run once the deployment has an administrator:

```bash
pnpm --filter @repo/api bootstrap-admin --email admin@example.com --name "Your Name"
```

It creates the `ADMIN` user with no password, prints a single-use invite link
(good for 7 days), and emails it as well when SMTP is configured. Open the link,
choose a password, and you land in the app signed in. The admin console is at
http://localhost:3000/admin.

In a container the command runs from the built output, with the same
environment the API uses:

```bash
node dist/bootstrap-admin.js --email admin@example.com
```

## Everybody else

From the admin console you add phone numbers, departments and other users.
Adding a user invites them: the console shows their link to copy, so onboarding
works before SMTP is configured. A user who is locked out gets a reset link —
from the console, or by asking for one on the sign-in page — and no admin ever
sets somebody else's password.

The admin's side of this is [Users and invites](../admin/users-and-invites.md).
Why it works this way is
[0007. A closed system with invite links](../decisions/0007-closed-system-with-invite-links.md).
