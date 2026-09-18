# CLAUDE.md

Guidance for AI coding assistants working in this repository. Humans should read it too.

## What this is

iziphone is a source-available business phone system for teams, built on Twilio. A browser softphone (Next.js + Twilio Voice SDK) talks to two Fastify services: a **call controller** that owns Twilio webhooks, TwiML, and call signaling, and a **business API** that owns users, departments, messaging, and call history. Redis connects them (pub/sub, routing cache, Socket.IO adapter). Postgres is used only by the API.

See `docs/develop/architecture.md` for the architecture and `LICENSE` for terms (PolyForm Shield 1.0.0, not OSI open source).

## Documentation

The manual lives in `docs/`, organized by audience: `docs/operate/` for whoever
runs a stack, `docs/admin/` for the customer's administrator, `docs/use/` for
agents, `docs/develop/` for developers, and `docs/decisions/` for decision
records. `docs/README.md` is the index; `README.md` is the front door and stays
short.

A change documents itself in the relevant `docs/<area>` page, not in the
README. A decision that is not obvious from the code gets a numbered record in
`docs/decisions/` (context, decision, consequences, alternatives); records are
immutable, and a changed decision gets a new one that supersedes the old.

## Layout

```
apps/web              Next.js 16 app router, Tailwind, shadcn/ui                :3000
apps/api              Fastify, Prisma, Better Auth, SMS/MMS, admin CRUD   :3001
apps/call-controller  Fastify, Twilio webhooks, Socket.IO, DB-free         :3002
packages/db           Prisma schema, client
packages/dto          Zod schemas shared by API, web, and controller
packages/events       Redis channels, event schemas, cache types, JWT verify
```

`apps/api/src` is organized by feature, not by layer: `auth/`, `calls/`,
`departments/`, `users/`, `phone-numbers/`, `messaging/`, `routing/` (the
cache the call controller reads and the `/internal` routing lookups), `admin/`
(audit log, service errors, dashboard stats), `health/`, `mail/` (the `Mailer`
behind `fastify.mailer`; SMTP when it is configured, a null mailer that reports
"not configured" when it is not), `media-store/` (the
S3-compatible bucket behind the `MediaStore` interface; features own their
keys, the store owns every S3 detail), and `infra/` (Prisma, Redis, rate
limiting, the error handler). Each module has an `index.ts` that
is its only public surface; import another module through it, never from its
files. Route files end in `.routes.ts`, and `routes.ts` at the root composes
them into the `/api/user`, `/api/admin` and `/internal` groups.

`apps/call-controller/src` follows the same shape: `config.ts` validates the
environment once at startup, `infra/` holds Redis and Twilio signature
validation, `routing/` the cache lookup with its API fallback, business hours
and the pure inbound call plan, `calls/` the call state in Redis, the Twilio
telephony service, the call flow the webhooks drive, the voice and webhook
routes and the Redis command and event bridges, `realtime/` the Socket.IO
server, its auth, presence and the call-ended broadcast, and `health/` the
health routes. `calls` never imports `realtime`; `app.ts` passes it in behind
the `CallRealtime` interface.

`apps/web/src` follows the app router: `app/` holds the routes, grouped into
`(auth)`, `(app)` and `(admin)`, `components/` the views and the shadcn/ui
primitives in `components/ui`, and `hooks/` the data hooks over the API plus
the telephony and socket hooks. The plumbing under them lives in `lib/`:
`lib/api` is the typed fetch layer (`client.ts` does the request, error
mapping and response validation with the `@repo/dto` schemas; `auth.ts`,
`user.ts`, `admin.ts` and `call-controller.ts` are the endpoint functions),
`lib/telephony` holds the pure `TelephonySession` state machine the Twilio
Device hook drives, `lib/inbox` and `lib/conversation` the merging, paging
and grouping rules the inbox and the thread are built from, `lib/messaging`
whether a message can be sent here and what a failure means, and
`lib/session-guard.ts` the cookie and redirect rules that `proxy.ts`
enforces. `AuthProvider` loads the user once and redirects signed-out
visitors; `AdminGuard` keeps non-admins out of `(admin)`. Permissions come
from `@repo/events`; response shapes from `@repo/dto`. Every view reads the
real API.

Design rule that must hold: **the call controller never touches Postgres.** It reads routing from the Redis cache the API writes, with an HTTP fallback to the API's `/internal` routes. Likewise **only the API talks to object storage**; the call controller has no bucket credentials.

## Commands

Requires Node 24 LTS and pnpm 12 (`corepack enable`). Postgres, Redis and
MinIO come from `docker compose -f docker-compose.dev.yml up -d`.

- Install: `pnpm install`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint` (`pnpm lint:fix` to apply fixes)
- Test (single file): `pnpm --filter @repo/api exec vitest run src/auth/auth.routes.test.ts`
  (swap the workspace name and path; on a fresh clone run `pnpm turbo run build --filter='./packages/*'` first)
- Test (all): `pnpm test`
- Run locally: `pnpm db:push` once, then `pnpm dev` (web :3000, api :3001, call controller :3002)
- Everything: `pnpm check` (lint + typecheck + test)

Turbo builds the shared packages before `dev`, `test`, and `typecheck` run, because every shared package exports only its compiled `dist/` and the apps use TypeScript project references to it. In `pnpm dev` the packages run `tsc --watch`, so edits to them rebuild automatically. Task results are cached; a second `pnpm check` with no changes is instant.

## Engineering conventions

The global engineering conventions (organize by feature, deep modules with one
entry point, pure logic separated from I/O, explicit dependencies, validated
boundaries, tests on every public interface, smallest correct change, ask
before adding libraries or abstractions) apply here in full. The repo-specific
rules below refine them.

## Conventions

- TypeScript, ESM, and relative imports carry the `.js` extension (`./plugins/auth.js`). Do not drop it; the `NodeNext` setting in `tsconfig.base.json` rejects extensionless imports at typecheck time.
- Every workspace `tsconfig.json` extends `tsconfig.base.json`, which turns on `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, and `verbatimModuleSyntax`. Indexing an array or record yields `T | undefined`; handle it instead of asserting with `!`.
- Biome is the formatter and linter. Run `pnpm lint:fix` before finishing a change.
- Tests live next to the code as `*.test.ts` and use Vitest (`import { describe, expect, test, vi } from 'vitest'`). Every file runs in its own process and all mocks, spies and stubbed env vars are reset before each test by `vitest.shared.ts`; do not rely on state from a previous test. Route tests use the helpers in `apps/*/src/test/route-test-helpers.ts`. Never add a test that calls a real third-party service.
- Validation at the HTTP boundary uses the Zod schemas in `packages/dto`. Add new request/response shapes there, not inline in routes.
- Services hold logic, routes stay thin. Admin mutations write an audit log entry.
- Redis channel names and cache key prefixes come from `packages/events`. Do not hard-code strings for them.
- Twilio webhooks must go through the signature-validation preHandler. Any new webhook route needs it.

## Data and privacy rules

- Use only fictional data in tests, fixtures, and docs: phone numbers in the reserved 555-01xx range, emails at `example.com`, made-up people and businesses.
- Never commit `.env` files, credentials, real phone numbers, customer or contact data, recordings, or transcripts.
- Do not log message bodies, transcripts, or full phone numbers at info level.
- Do not add default admin credentials, demo logins, seed scripts, or auth bypasses. Sign-up is closed: the first admin is created by `pnpm --filter @repo/api bootstrap-admin --email <address>`, which refuses once one exists, and everybody else is invited from the admin console (see `docs/operate/first-admin.md`). Nobody, including an admin, sets another person's password: a single-use link does.

## Things that will bite you

- Running `tsc` or `vitest` directly inside an app on a fresh clone fails until the packages are built. Go through the root Turbo scripts, which build them first.
- The services run on Node, not Bun. Do not use Bun-only APIs (`Bun.*`, `bun:*` imports) anywhere in `apps/` or `packages/`.
- Prisma 7 generates the client into `packages/db/src/generated/` (gitignored) and `tsc` compiles it into `dist/`. `packages/db/prisma.config.ts` loads the repository-root `.env`; the schema file no longer contains the database URL.
- The `prisma` CLI lives in the root `devDependencies`, not in `packages/db`, and `pnpm-workspace.yaml` turns off `autoInstallPeers`, `dedupePeerDependents`, and `resolvePeersFromWorkspaceRoot`. Together these keep `@prisma/client`'s and `better-auth`'s optional peers (the Prisma CLI, Studio, TypeScript, Next.js) out of the production images. If a new dependency needs a peer, declare it explicitly in that workspace, then run `pnpm peers check`.
  `packages/db` deliberately declares no `typescript` of its own: `@prisma/client` would resolve it as a peer and pnpm would then ship the compiler in the production image. It uses the root one.
- Prisma is on `db:push` with no migrations directory yet. Do not run `db:push` against anything but a local database.
- `NODE_ENV=development` disables Twilio signature validation in both services. Never set it on a reachable deployment.
- Better Auth cookies get a `__Secure-` prefix in production. Anything that reads the session cookie by name must handle both forms.
- The routing cache has a 24-hour TTL. Any mutation that changes which user or department a phone number routes to must invalidate it.

## Scope guardrails

This is a focused product, not a platform. Do not add multi-tenancy, a new permissions system, or a different provider abstraction without an issue discussing it first. Prefer fixing the existing path over adding a parallel one.
