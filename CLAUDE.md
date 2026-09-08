# CLAUDE.md

Guidance for AI coding assistants working in this repository. Humans should read it too.

## What this is

iziphone is a source-available business phone system for teams, built on Twilio. A browser softphone (Next.js + Twilio Voice SDK) talks to two Fastify services: a **call controller** that owns Twilio webhooks, TwiML, and call signaling, and a **business API** that owns users, departments, messaging, and call history. Redis connects them (pub/sub, routing cache, Socket.IO adapter). Postgres is used only by the API.

See `README.md` for the architecture and `LICENSE` for terms (PolyForm Shield 1.0.0, not OSI open source).

## Layout

```
apps/web              Next.js 15 app router, Tailwind, shadcn/ui
apps/api              Fastify, Prisma, Better Auth, SMS/MMS, admin CRUD   :3001
apps/call-controller  Fastify, Twilio webhooks, Socket.IO, DB-free         :3002
packages/db           Prisma schema, client
packages/dto          Zod schemas shared by API, web, and controller
packages/events       Redis channels, event schemas, cache types, JWT verify
```

Design rule that must hold: **the call controller never touches Postgres.** It reads routing from the Redis cache the API writes, with an HTTP fallback to the API's `/internal` routes.

## Commands

```bash
pnpm install                                         # Node 24 LTS, pnpm 12 (corepack enable)
docker compose -f docker-compose.dev.yml up -d       # Postgres + Redis
pnpm db:push                                         # generates the Prisma client and applies the schema
pnpm dev                                             # builds shared packages, then all three apps via turbo

pnpm test                                            # turbo -> vitest per workspace, mocked Twilio/Redis/Postgres
pnpm typecheck                                       # turbo -> tsc --noEmit per app
pnpm lint                                            # biome check
pnpm check                                           # lint + typecheck + test
pnpm lint:fix
```

Turbo builds the shared packages before `dev`, `test`, and `typecheck` run, because every shared package exports only its compiled `dist/` and the apps use TypeScript project references to it. In `pnpm dev` the packages run `tsc --watch`, so edits to them rebuild automatically. Task results are cached; a second `pnpm check` with no changes is instant.

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

- Use only fictional data in tests, fixtures, and docs: phone numbers in the reserved 555-01xx range, emails at `example.com`, made-up people and businesses. `apps/web/src/lib/mock-data` shows the pattern.
- Never commit `.env` files, credentials, real phone numbers, customer or contact data, recordings, or transcripts.
- Do not log message bodies, transcripts, or full phone numbers at info level.
- Do not add default admin credentials, demo logins, seed scripts, or auth bypasses. The first admin is created by registering and promoting the user in the database (see README).

## Things that will bite you

- Running `tsc` or `vitest` directly inside an app on a fresh clone fails until the packages are built. Go through the root Turbo scripts, which build them first.
- The services run on Node, not Bun. Do not use Bun-only APIs (`Bun.*`, `bun:*` imports) anywhere in `apps/` or `packages/`.
- Prisma 7 generates the client into `packages/db/src/generated/` (gitignored) and `tsc` compiles it into `dist/`. `packages/db/prisma.config.ts` loads the repository-root `.env`; the schema file no longer contains the database URL.
- The `prisma` CLI lives in the root `devDependencies`, not in `packages/db`, and `pnpm-workspace.yaml` turns off `autoInstallPeers`, `dedupePeerDependents`, and `resolvePeersFromWorkspaceRoot`. Together these keep `@prisma/client`'s and `better-auth`'s optional peers (the Prisma CLI, Studio, TypeScript, Next.js) out of the production images. If a new dependency needs a peer, declare it explicitly in that workspace, then run `pnpm peers check`.
- Prisma is on `db:push` with no migrations directory yet. Do not run `db:push` against anything but a local database.
- `NODE_ENV=development` disables Twilio signature validation in both services. Never set it on a reachable deployment.
- Better Auth cookies get a `__Secure-` prefix in production. Anything that reads the session cookie by name must handle both forms.
- The routing cache has a 24-hour TTL. Any mutation that changes which user or department a phone number routes to must invalidate it.

## Scope guardrails

This is a focused product, not a platform. Do not add multi-tenancy, a new permissions system, or a different provider abstraction without an issue discussing it first. Prefer fixing the existing path over adding a parallel one.
