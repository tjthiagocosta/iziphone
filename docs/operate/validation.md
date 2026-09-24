# Validation and upgrading

For whoever runs a stack or a development machine. Covers the checks that prove
a checkout is sound, and the commands to run after pulling a new version.

## Checks

```bash
pnpm lint                # Biome: lint + format check
pnpm typecheck           # tsc --noEmit in every app (Turbo builds the packages first)
pnpm test                # Vitest in every workspace (Turbo builds the packages first)
pnpm check               # all three
```

Turbo caches every task, so a second run with no changes finishes in
milliseconds. To run one workspace's tests in watch mode, use
`pnpm --filter @repo/api exec vitest`.

## Upgrading

After pulling a new version:

```bash
pnpm install             # dependencies may have moved
pnpm db:push             # apply the schema and regenerate the Prisma client
pnpm build               # production build; skip it if you run pnpm dev
pnpm check               # lint, typecheck and tests
```

There is no migrations directory yet: the schema is applied with
`prisma db push`, which reshapes the database to match rather than replaying a
migration.

`db:push` stops with a data-loss warning whenever a change adds a unique
constraint, because existing rows could break it. Read the warning before
accepting it with `pnpm db:push -- --accept-data-loss`. Changes known to be
safe:

- **Text conversations keyed by owner** ([decision 0011](../decisions/0011-a-lines-history-stays-with-the-owner-it-was-written-under.md)).
  The unique key on `message_conversations` (contact, number) is replaced by
  two: (contact, number, user) and (contact, number, department). The old key
  was stricter, so no existing row can break the new ones, and existing rows
  need no backfill: each already names the owner it belongs to.

Calls in progress survive an upgrade of the call controller: their state is in
Redis, and the controller that starts finds every call's state, including one
it did not track yet, claims its people again and asks Twilio whether it is
still going. Stop the old controller with `SIGTERM` rather than killing it: it
then finishes the calls it is asking Twilio about, for up to eight seconds, and
gives up the reconcile lock, so the new one asks Twilio at once instead of
within five minutes. Give it at least ten seconds to stop, as Docker does by
default. A call still being handled when the eight seconds run out, which
takes a slow or unreachable Twilio, can lose its end: the API is never told it
ended and keeps showing it in progress. The next reconciliation covers what it
can, a call whose state is still in Redis, but not one whose state was removed
before its end was reported.

Once the services are up, `GET /health` answers without touching the bucket,
and `GET /health/storage` and `GET /health/all` (admin only) report whether the
bucket answers.

## Related

- [Testing](../develop/testing.md) — what the test suite does and does not touch
- [Deploying](deploy.md)
