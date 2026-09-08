# Security Policy

iziphone handles phone calls, text messages, recordings and contact data. Security reports are taken seriously, and we would rather hear about a problem privately than read about it in a public issue.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security problem.** Public reports are visible to everyone, including people who could exploit the issue before a fix ships.

Use GitHub's private vulnerability reporting instead:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the form. GitHub creates a private advisory that only you and the maintainers can see.

Please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, or a proof of concept. Use fictional phone numbers and test accounts only.
- The commit or release you tested against.
- Any suggested fix, if you have one.

## What to expect

This project is maintained by a small team in its spare time. We aim to:

- Acknowledge your report within 7 days.
- Confirm or dismiss the issue, and give you an estimated fix timeline, within 30 days.
- Credit you in the advisory and release notes when the fix ships, unless you prefer to stay anonymous.

We will keep you updated through the advisory thread. Please give us a reasonable window to fix the issue before disclosing it publicly. Ninety days from acknowledgement is our default, and we are happy to agree on something else if you have a reason.

## Safe harbor

If you research this project in good faith and follow this policy, we will not pursue legal action against you or report you to law enforcement. Good faith means:

- You only test against instances you own or have permission to test. Do not test against someone else's deployment.
- You do not access, modify, or delete data that is not yours, and you stop as soon as you have enough evidence to report.
- You do not place calls, send messages, or otherwise generate Twilio traffic on an account you do not own.
- You do not run denial-of-service tests or spam a deployment's webhooks.

## Scope

In scope:

- Code in this repository: the web app, the business API, the call controller, and the shared packages.
- Default configuration and documentation that would lead a self-hoster into an insecure setup.
- The Dockerfiles and build scripts.

Out of scope:

- Twilio's platform, SDKs, or infrastructure. Report those to [Twilio](https://www.twilio.com/en-us/security).
- Third-party dependencies, unless this project uses them in an unsafe way. Report upstream bugs upstream, and tell us if we need to update.
- Issues that require a self-hoster to ignore the documentation, such as running with `NODE_ENV=development` on a public host or exposing the API's internal routes to the internet.
- Rate limiting and brute-force findings on a local development instance.
- Reports from automated scanners with no demonstrated impact.

## Supported versions

iziphone is in early alpha and has no tagged releases yet. Security fixes land on the `main` branch only. If you self-host, track `main` and rebuild when fixes are announced.

| Version | Supported |
|---|---|
| `main` | Yes |
| Anything older | No |

## Known limitations

This project has not had a formal security audit. Things you should know before deploying it:

- **Signature validation is off in development.** Twilio webhook signature checks are skipped when `NODE_ENV=development` so local tunnels are easy to use. Every deployed environment must run with `NODE_ENV=production`.
- **Internal API routes trust the network.** The API's `/internal/*` routes are called by the call controller and do not yet require their own authentication. Bind them to a private network and do not publish that port.
- **The web app's route guard is not production-ready.** It does not yet recognise the `__Secure-` prefixed session cookie the API sets in production. This affects redirect behavior, not the API's own authorization checks, but treat it as an open issue.
- **No migrations yet.** The schema is applied with `prisma db push`. Be careful with that command against any database you care about.

These are tracked as issues. Reports that add new information about them are still welcome.

## Hardening checklist for self-hosters

- Put every service behind HTTPS with a reverse proxy, and set `NODE_ENV=production`.
- Generate a fresh `BETTER_AUTH_SECRET` per deployment. It signs sessions and the realtime JWT.
- Keep the API's internal routes and the databases on a private network.
- Use a Twilio API key scoped to this deployment rather than the account's main credentials where possible, and rotate it if it leaks.
- Restrict who can listen to recordings and read transcripts. The `SUPERVISOR` and `ADMIN` roles can access them.
- Back up Postgres, and remember that call recordings and voicemail live on Twilio, not in your database.
- Keep dependencies current. Enable Dependabot or an equivalent on your fork.

Thank you for helping keep the people who rely on this phone system safe.
