# 0015. Twilio signatures are checked unless a development stack says otherwise

Date: 2026-10-02 · Status: Accepted

## Context

Every Twilio webhook carries a signature computed over the public URL Twilio
called and the form body, with the account's auth token. Both services check
it in a preHandler, and until now both skipped the check whenever
`NODE_ENV=development`, so a developer could post a webhook by hand.

That tied a security control to a setting that means something else. A
development stack is exactly the one that sits behind a tunnel during a test
against a real Twilio account, with its webhook routes on a public address.
With the check off there, anyone who learns the address can post a fake
inbound text, a fake call status or a fake inbound call, and nothing in a test
run shows whether the check would have passed: the one place where the public
URL is rebuilt behind a proxy, and could be rebuilt wrong, was the one place it
was never exercised. Turning the check on meant running as production, which
also changes cookies and logging.

## Decision

The check has its own switch, `TWILIO_SIGNATURE_CHECK`, `on` or `off`, read by
both services.

- **On by default, in every environment.** A development stack checks
  signatures unless it says otherwise, so a test behind a tunnel runs the same
  check production does.
- **Off is for posting webhooks by hand.** A developer who wants to `curl` a
  webhook sets `TWILIO_SIGNATURE_CHECK=off` on a development stack, and both services
  log a warning at boot while it is off.
- **Only development may turn it off.** The configuration fails at boot when
  the switch is off and `NODE_ENV` is anything but `development`. `NODE_ENV`
  defaults to `production`, so a stack that forgets to set it is held to the
  check too.

## Consequences

- A development stack that used to accept unsigned webhooks now answers them
  with 403 until it sets the switch off. Twilio's own requests pass as long as
  `BETTER_AUTH_URL` and `WEBHOOK_BASE_URL` are the addresses Twilio calls.
- A live test through a tunnel proves the public URL the services rebuild
  matches the one Twilio signed, which is what a production proxy needs.
- `NODE_ENV=development` still turns off secure cookies; it no longer touches
  the webhook check.

## Alternatives considered

- **Keep tying the check to `NODE_ENV`, and run tests as production.**
  Production mode also changes cookies, which a browser on `localhost` cannot
  carry, so a live test would not be able to sign in.
- **No switch at all; tests sign their own requests.** Route tests already do.
  A developer posting by hand would then have to compute signatures, and the
  switch costs one line of configuration, refused where it matters.
- **Allow off in production with a loud warning.** A warning in a log nobody
  reads protects nothing; a production stack has no reason to accept an
  unsigned webhook.
