# iziphone documentation

Everything about running, administering, using and developing iziphone. Find
yourself below and start there.

| You are | Start with |
|---|---|
| Setting up a stack, or a development machine | [Install and run locally](operate/install.md) |
| The administrator of a running deployment | [Users and invites](admin/users-and-invites.md) |
| An agent making and taking calls | [The softphone](use/softphone.md) |
| Changing the code | [Architecture](develop/architecture.md) |

## Operate

For whoever runs a stack.

- [Install and run locally](operate/install.md) — prerequisites, the dev compose stack, installing, starting the three services
- [Creating the first admin](operate/first-admin.md) — the `bootstrap-admin` command, and how everybody else gets in
- [Twilio configuration](operate/twilio.md) — API key, TwiML application, per-number webhooks, tunnels, account settings
- [Object storage](operate/object-storage.md) — the bucket, the provider table, the permissions its key needs
- [Email](operate/email.md) — the optional SMTP pair, and what happens without it
- [Environment variables](operate/environment.md) — every variable, which service reads it, what it is for
- [Deploying](operate/deploy.md) — the production build, the reverse proxy, `TRUST_PROXY`
- [Validation and upgrading](operate/validation.md) — the checks, and what to run after pulling

## Administer

For the customer's administrator.

- [Users and invites](admin/users-and-invites.md) — inviting, resending, reset links, deleting and restoring
- [Departments and routing](admin/departments-and-routing.md) — members, numbers, business hours, what a call does
- [Voicemail greeting](admin/voicemail-greeting.md) — uploading the audio callers hear, and the fallback
- [Recording retention](admin/recording-retention.md) — how long recordings are kept, and who may hear them
- [Permissions and roles](admin/permissions-and-roles.md) — the three roles and what each may do

## Use

For agents.

- [The softphone](use/softphone.md) — placing and taking calls, mute, hold, transfer
- [Voicemail and recordings](use/voicemail-and-recordings.md) — where audio appears and who can play it
- [Messaging](use/messaging.md) — the inbox, sending, and why a composer is disabled

## Develop

For developers.

- [Architecture](develop/architecture.md) — the two services, Redis between them, the two rules, the tech stack
- [Project structure](develop/project-structure.md) — the monorepo layout
- [Conventions and commands](develop/conventions.md) — the daily commands and the rules a change follows
- [Testing](develop/testing.md) — what the suite covers and the one hard rule
- [Contributing](develop/contributing.md) — issue first, and where the full policy lives
- [Reporting a security issue](develop/security.md) — report privately, never in an issue
- [Costs](develop/costs.md) — what Twilio and your bucket charge for

## Decisions

- [Decision records](decisions/README.md) — numbered, immutable notes on the choices that are not obvious from the code
