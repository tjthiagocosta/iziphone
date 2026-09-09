# iziphone

A source-available business phone system for teams, powered by Twilio.

Own your phone system. iziphone runs on your own server and your own Twilio account, so your numbers, call history, recordings and messages stay with you. You pay Twilio for the calls and texts you actually make, and nothing per seat.

> **Status: early alpha.** Several core features work end-to-end, but the project is not production-ready. Expect breaking changes, gaps, and rough edges. See [Where it stands](#where-it-stands) before relying on it.

## What it does

- **Browser softphone.** Agents make and receive calls from the web app using the Twilio Voice SDK. No desk phones, no desktop client.
- **Department routing.** Inbound calls to a number ring the members of its department. Members can be online or offline, and a call can go to voicemail when nobody answers.
- **Conference-first calls.** Every call is a Twilio conference, so hold, transfer and supervisor features are consistent for inbound and outbound calls.
- **Hold and transfer.** Put callers on hold with hold music and transfer them to another user or department.
- **Shared SMS and MMS inboxes.** Text conversations per phone number, shared across a team, with media attachments and STOP keyword suppression.
- **Recording and transcription.** Calls can be recorded and transcribed through Twilio, with playback restricted by role.
- **Admin console.** Manage users, departments, phone numbers and roles (`ADMIN`, `SUPERVISOR`, `AGENT`), and see basic call statistics.
- **Session management.** Email and password sign-in with Better Auth. Users can review and revoke their active sessions.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | [Node.js](https://nodejs.org) 24 LTS |
| Package manager | [pnpm](https://pnpm.io) 12 |
| Monorepo | [Turborepo](https://turbo.build) 2, pnpm workspaces |
| Web app | [Next.js](https://nextjs.org) 16 (App Router), React 19, Tailwind CSS 4, [shadcn/ui](https://ui.shadcn.com) |
| Browser telephony | [@twilio/voice-sdk](https://www.twilio.com/docs/voice/sdks/javascript) 2 |
| API and call controller | [Fastify](https://fastify.dev) 5 |
| Authentication | [Better Auth](https://www.better-auth.com) 1.7 (cookie sessions, HS256 JWT for the call controller) |
| Database | PostgreSQL 18 via [Prisma](https://www.prisma.io) 7 |
| Cache, pub/sub, routing state | Redis 8 via ioredis 6 |
| Realtime | [Socket.IO](https://socket.io) 4 with the Redis adapter |
| Telephony backend | [Twilio](https://www.twilio.com) Programmable Voice and Messaging (Node SDK 6) |
| Validation | [Zod](https://zod.dev) 4 |
| Lint and format | [Biome](https://biomejs.dev) 2 |
| Tests | [Vitest](https://vitest.dev) 5 |
| Language | TypeScript 7, strict, ESM |

## Project structure

```
iziphone/
├── apps/
│   ├── web/              Next.js app: softphone, inbox, admin console
│   ├── api/              Business API: auth, users, departments, numbers,
│   │                     messaging, Twilio messaging webhooks, internal routes
│   └── call-controller/  Voice service: Twilio voice webhooks, TwiML,
│                         conference control, Socket.IO, voice tokens
├── packages/
│   ├── db/               Prisma schema and generated client
│   ├── dto/              Zod schemas and shared request/response types
│   └── events/           Redis channel names, event schemas, cache types,
│                         JWT verification, roles and permissions
├── biome.json
├── docker-compose.dev.yml  Postgres + Redis for local development
├── pnpm-workspace.yaml
├── tsconfig.base.json    Shared compiler options (strict, NodeNext)
├── turbo.json
├── vitest.shared.ts      Test isolation settings shared by every workspace
└── .env.example
```

## Architecture

```
                     ┌──────────────────────────┐
                     │        apps/web           │
                     │  Next.js + Twilio Voice   │
                     └──────┬─────────────┬──────┘
               HTTP (cookie)│             │ Socket.IO (JWT)
                            ▼             ▼
                 ┌────────────────┐   ┌─────────────────────┐
                 │   apps/api     │   │ apps/call-controller│◄──── Twilio voice
                 │  Fastify 5     │   │     Fastify 5       │      webhooks
                 │  Prisma 7      │   │  no database access │
                 └───┬────────┬───┘   └──────────┬──────────┘
      Twilio         │        │                  │
      messaging ─────┘        │  Redis pub/sub   │
      webhooks                │  + routing cache │
                              ▼                  ▼
                     ┌────────────────┐  ┌───────────────┐
                     │  PostgreSQL 18 │  │    Redis 8    │ 
                     └────────────────┘  └───────────────┘
```

**Three services, one database.** The web app talks to the API over HTTP with a session cookie. The API owns the database and all business logic. The call controller handles everything time-sensitive on a live call and never touches the database.

**The call controller reads routing from Redis.** When an admin changes a department, a phone number, or a user, the API writes a routing snapshot to Redis (keys under `routing:phone:*`). Inbound webhooks resolve the destination from that cache. If a key is missing, the controller falls back to an HTTP call to the API's internal routes.

**Call events flow through Redis pub/sub.** The call controller publishes call lifecycle events and the API subscribes to persist them. Channel names live in `packages/events`:

| Channel | Published by | Meaning |
|---|---|---|
| `call:incoming` | call-controller | Inbound call received |
| `call:started` | call-controller | Call answered / conference joined |
| `call:ended` | call-controller | Call finished |
| `call:missed` | call-controller | Nobody answered |
| `call:transferred` | call-controller | Transfer completed |
| `call:participant-status` | call-controller | Participant joined, left, muted, held |
| `call:recording-ready` | call-controller | Recording available |
| `call:transcription-ready` | call-controller | Transcript available |
| `call:conversation-migrated` | call-controller | Call SID changed mid-call |
| `call:transfer`, `call:hold`, `call:hangup` | api | Commands sent to the call controller |

**Conference-first calling.** Inbound and outbound calls are placed into a Twilio conference from the start. The controller keeps per-call state in Redis (`telephony:call:*`, `telephony:leg:*`, `call:participants:*`) with TTLs of one to four hours so abandoned state cleans itself up. Hold, transfer and supervisor features all work by adding, removing or updating conference participants instead of re-dialing.

**Realtime to the browser.** The call controller runs Socket.IO with the Redis adapter, so it can scale horizontally. Users authenticate to the socket with a short-lived JWT issued by the API. Each user's sockets are tracked in Redis (`user:sockets:*`) so an inbound call can ring every tab and device that user has open.

**Browser softphone behavior.** The web app registers a Twilio Voice device on sign-in and refreshes its token before it expires. Do Not Disturb is a client-side setting: the device stays registered and incoming calls are rejected in the browser. Microphone access is requested before the device registers.

## Where it stands

Working today:

- Sign in, sessions, roles and permissions
- Inbound calls to department numbers, ringing every online member
- Outbound calls from the browser softphone
- Hold, mute, transfer to users and departments
- Call history, recordings and transcripts
- Shared SMS/MMS conversations with inbound and outbound messages
- Admin console for users, departments and phone numbers, with soft delete and restore

Planned or incomplete:

- Mobile apps
- Call queues with wait positions and callbacks
- IVR menus and business hours routing
- Multi-tenant hosting (the system is single-organization by design)
- Automated database migrations (the schema is applied with `prisma db push` for now)
- Deployment configuration (Dockerfiles exist for `api` and `call-controller`, but there is no compose file or reference deployment yet)

## Prerequisites

- Node.js 24 LTS or newer (`.nvmrc` pins 24)
- pnpm 12 or newer (`corepack enable` installs the pinned version automatically)
- PostgreSQL 18 and Redis 8, running locally or reachable from your machine
- A Twilio account with a phone number, an API key and secret, and a TwiML application
- A public HTTPS URL for Twilio webhooks during development, for example an [ngrok](https://ngrok.com) tunnel

If you have Docker, the quickest way to get the databases is the dev compose file:

```bash
docker compose -f docker-compose.dev.yml up -d
```

These match the defaults in `.env.example`. Change the password for anything beyond local development.

## Installation

```bash
git clone https://github.com/<your-org>/iziphone.git
cd iziphone
pnpm install
cp .env.example .env
```

Fill in `.env`. The variables are described in [Environment variables](#environment-variables).

## Local development

```bash
# Apply the schema to your database (also generates the Prisma client)
pnpm db:push

# Build the shared packages and start all three services with hot reload
pnpm dev
```

| Service | URL |
|---|---|
| Web app | http://localhost:3000 |
| API | http://localhost:3001 |
| Call controller | http://localhost:3002 |

### First admin account

New accounts are created with the `AGENT` role, and only an admin can change roles. To bootstrap the first admin:

1. Open http://localhost:3000/register and create your account.
2. Run `pnpm db:studio`, open the `User` table, and set your row's `role` to `ADMIN`.
3. Sign in again. The admin console is at http://localhost:3000/admin.

From there you can add phone numbers, departments and other users through the UI.

Other useful commands:

```bash
pnpm db:studio           # Prisma Studio
pnpm build               # Build every package and app
pnpm clean               # Remove build outputs
```

## Twilio configuration

1. Create an **API key and secret** in the Twilio console. The call controller uses them to mint browser voice tokens.
2. Create a **TwiML application** and copy its SID into `TWILIO_TWIML_APP_SID`. Set its Voice request URL to the call controller's voice webhook. Browser-originated calls arrive there with an `outbound-pstn` type.
3. For each **phone number** you add through the admin console, point its Voice webhook at the call controller and its Messaging webhooks at the API:
   - Voice: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/inbound`
   - Voice status callback: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/status`
   - Messaging: `<api url>/webhooks/twilio/messages/inbound`
   - Messaging status callback: `<api url>/webhooks/twilio/messages/status`
4. Expose the call controller and API over HTTPS. With ngrok, start one tunnel per service and put the tunnel URLs in `WEBHOOK_BASE_URL` and `BETTER_AUTH_URL`.
5. Optionally set `TWILIO_HOLD_AUDIO_URL` to a public MP3 or WAV for hold music. A Twilio-hosted classical track is used when it is empty.

Twilio signs every webhook. Signature validation is enforced when `NODE_ENV` is anything other than `development`, and skipped in development so local tunnels are easy to work with. Never run with `NODE_ENV=development` on a public host.

## Environment variables

All services and the Prisma CLI read the root `.env`. `.env.example` documents every variable with local defaults.

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | api, db | PostgreSQL connection string |
| `REDIS_URL` | api, call-controller | Redis connection string |
| `NODE_ENV` | all | `development` or `production`. Controls webhook signature validation and secure cookies |
| `LOG_LEVEL` | api, call-controller | Pino log level |
| `API_PORT`, `API_HOST` | api | Listen address (default `3001`) |
| `CALL_CONTROLLER_PORT`, `CALL_CONTROLLER_HOST` | call-controller | Listen address (default `3002`) |
| `BETTER_AUTH_SECRET` | api, call-controller | Session signing secret. Also signs the socket JWT. Generate with `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | api | Public URL of the API. Auth callbacks, Twilio messaging webhooks and media links are built on it |
| `INTERNAL_API_TOKEN` | api, call-controller | Shared secret the call controller presents on the API's `/internal` routes. Generate with `openssl rand -base64 32` |
| `CORS_ORIGIN` | api, call-controller | Allowed browser origin (the web app URL) |
| `NEXT_PUBLIC_API_URL` | web | API URL the browser calls |
| `NEXT_PUBLIC_CALL_CONTROLLER_URL` | web | Call controller URL for Socket.IO and voice tokens |
| `WEBHOOK_BASE_URL` | api, call-controller | Public HTTPS base URL of the call controller that Twilio can reach |
| `INTERNAL_API_URL` | call-controller | Where the call controller reaches the API's internal routes (default `http://localhost:3001`) |
| `DEPARTMENT_CACHE_TTL_SECONDS` | api | Routing cache TTL in Redis (default 24 hours) |
| `MESSAGING_MEDIA_STORAGE_DIR` | api | Directory for MMS attachments (default `.data/messaging-media`) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | api, call-controller | Account credentials and webhook signature validation. Set both or neither |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET` | call-controller | Voice token minting |
| `TWILIO_TWIML_APP_SID` | call-controller | TwiML app for outbound browser calls |
| `TWILIO_PHONE_NUMBER` | api, call-controller | Default caller ID when a user has no assigned number |
| `TWILIO_HOLD_AUDIO_URL` | call-controller | Optional hold music URL |

In production, session cookies are set with the `__Secure-` prefix and require HTTPS.

## Validation

```bash
pnpm lint                # Biome: lint + format check
pnpm typecheck           # tsc --noEmit in every app (Turbo builds the packages first)
pnpm test                # Vitest in every workspace (Turbo builds the packages first)
pnpm check               # all three
```

Turbo caches every task, so a second run with no changes finishes in milliseconds. To run one workspace's tests in watch mode, use `pnpm --filter @repo/api exec vitest`.

Tests mock Twilio, Redis and Postgres. Nothing in the test suite talks to a live service. Every test file runs in its own process, and all mocks, spies and stubbed environment variables are reset before each test (see `vitest.shared.ts`).

## Building for production

```bash
pnpm build
```

- `apps/api` and `apps/call-controller` compile to `dist/` and start with `node dist/index.js`. Both have a multi-stage `Dockerfile`.
- `apps/web` builds a standalone Next.js server (`output: 'standalone'`).

Run the API and the call controller behind an HTTPS reverse proxy, set `NODE_ENV=production`, and make sure the call controller's public URL matches `WEBHOOK_BASE_URL`. The API's `/internal/*` routes are meant for the call controller only and must not be exposed to the internet. Managed Postgres and Redis are strongly recommended over self-run instances.

## Costs

iziphone is free to run, but Twilio is not. You pay Twilio for phone numbers, voice minutes, recordings, transcription and messages. Check [Twilio's pricing](https://www.twilio.com/pricing) for your country before putting real traffic through the system, and watch your account during development. A misconfigured routing loop can generate charges quickly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before starting anything larger than a small fix.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

iziphone is source-available under the [PolyForm Shield License 1.0.0](LICENSE).
