# Deploying

For whoever runs a stack in production. Covers the production build, what sits
behind the reverse proxy, and the `TRUST_PROXY` setting the rate limiter and
the audit log depend on.

## Building

```bash
pnpm build
```

- `apps/api` and `apps/call-controller` compile to `dist/` and start with `node dist/index.js`. Both have a multi-stage `Dockerfile`.
- `apps/web` builds a standalone Next.js server (`output: 'standalone'`). The
  standalone output leaves out `.next/static` and `public`, expecting a CDN to
  serve them; the image copies both in beside the server instead. Anything
  served from `public/`, such as the sound a new message makes, is missing from
  a deployment that skips that step.

## Running

Run the API and the call controller behind an HTTPS reverse proxy, set
`NODE_ENV=production`, and make sure the call controller's public URL matches
`WEBHOOK_BASE_URL`. The API's `/internal/*` routes are meant for the call
controller only and must not be exposed to the internet. Managed Postgres,
Redis and object storage are strongly recommended over self-run instances; the
API container keeps no media on its own disk.

## Behind a reverse proxy: `TRUST_PROXY`

Behind a reverse proxy set `TRUST_PROXY`. The API rate-limits each client
address (100 requests a minute, and 10 a minute on the credential endpoints,
every `POST /api/auth/*`, so that passwords cannot be guessed at speed) and the
audit log records the address of whoever made the change, and both read
`request.ip`. Left at its default of `false`, `request.ip` is the proxy's own
address, so every client shares one bucket and one identity in the log. Set
`TRUST_PROXY=true` only when nothing but your proxy can reach the API;
otherwise give it the proxies' addresses or CIDR ranges, comma-separated
(`loopback`, `linklocal` and `uniquelocal` also work). A hop count is refused,
because Fastify accepts one and then trusts nothing. Trusting a proxy that is
not there lets anyone forge `X-Forwarded-For` and get a fresh rate-limit bucket
per request.

Exempt from the limit, because a 429 there breaks a caller that cannot ask
again: the signature-validated `/webhooks/twilio/*` routes (Twilio does not
retry a 4xx), the public `/media/*` links (Twilio fetches MMS attachments and
voicemail greetings from them mid-call), and `/internal/*` (the call controller
bursts through them on a cold routing cache).

## Related

- [Environment variables](environment.md)
- [Twilio configuration](twilio.md) — the webhook URLs the proxy must carry
- [Validation and upgrading](validation.md)
