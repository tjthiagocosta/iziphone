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

Once the services are up, `GET /health` answers without touching the bucket,
and `GET /health/storage` and `GET /health/all` (admin only) report whether the
bucket answers.

## Related

- [Testing](../develop/testing.md) — what the test suite does and does not touch
- [Deploying](deploy.md)
