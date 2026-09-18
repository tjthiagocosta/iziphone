# iziphone

A source-available business phone system for teams, powered by Twilio.

Own your phone system. iziphone runs on your own server and your own Twilio account, so your numbers, call history, recordings and messages stay with you. You pay Twilio for the calls and texts you actually make, and nothing per seat.

> **Status: early alpha.** Several core features work end-to-end, but the project is not production-ready. Expect breaking changes, gaps, and rough edges. See [Where it stands](#where-it-stands) before relying on it.

## What it does

- **Browser softphone.** Agents make and receive calls from the web app using the Twilio Voice SDK. No desk phones, no desktop client.
- **Department routing.** Inbound calls to a number ring the members of its department. Members can be online or offline, and a call can go to voicemail when nobody answers.
- **Conference-first calls.** Every call is a Twilio conference, so hold, transfer and supervisor features are consistent for inbound and outbound calls.
- **Hold and transfer.** Put the other party on hold with hold music and hand the call to a teammate, who sees who is calling and who is transferring before answering.
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
| Media storage | Any S3-compatible bucket via `@aws-sdk/client-s3` 3 (MinIO in development) |
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
├── docker-compose.dev.yml  Postgres + Redis + MinIO for local development
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

**Media lives in an S3-compatible bucket.** MMS attachments are written to and read from object storage by the API alone (`apps/api/src/media-store`), and served to browsers and to Twilio through the API's own `/media` routes, so the bucket stays private. Any provider that speaks the S3 API works; see [Object storage](#object-storage).

**The call controller reads routing from Redis.** When an admin changes a department, a phone number, or a user, the API writes a routing snapshot to Redis (keys under `routing:phone:*`). Inbound webhooks resolve the destination from that cache. If a key is missing, the controller falls back to an HTTP call to the API's internal routes.

**Call events flow through Redis pub/sub.** The call controller publishes call lifecycle events and the API subscribes to persist them. Channel names live in `packages/events`:

| Channel | Published by | Meaning |
|---|---|---|
| `call:incoming` | call-controller | Inbound call received |
| `call:started` | call-controller | Call answered / conference joined |
| `call:ended` | call-controller | Call finished |
| `call:missed` | call-controller | Nobody answered |
| `call:transferred` | call-controller | Transfer completed |
| `call:held`, `call:resumed` | call-controller | The other party was put on hold, or taken off it |
| `call:participant-status` | call-controller | Participant joined, left, muted, held |
| `call:recording-ready` | call-controller | Recording available |
| `call:transcription-ready` | call-controller | Transcript available |
| `call:conversation-migrated` | call-controller | Call SID changed mid-call |
| `call:hangup` | api | Command sent to the call controller |

Hold and transfer are not commands. The softphone asks the call controller for them directly (`POST /api/voice/calls/:legUuid/hold`, `/transfer` and `/transfer/cancel`, with the realtime JWT), because only the controller can check the request against the live call and answer with what happened. How a transfer ended reaches the softphones as the `call_transfer_outcome` socket event.

An outbound call starts the same way: the softphone asks `POST /api/voice/outbound-grants` for a grant to call a number from one of the user's lines, and dials through Twilio with the grant alone. The controller checks the line against the routing cache (the people a number rings are the people who may call from it), keeps the grant in Redis for a minute (`voice:outbound-grant:*`), and consumes it when Twilio's webhook brings it back, so the webhook needs nothing the browser could forge.

**Conference-first calling.** Inbound and outbound calls are placed into a Twilio conference from the start. The controller keeps per-call state in Redis (`telephony:call:*`, `telephony:leg:*`, `call:participants:*`) with TTLs of one to four hours so abandoned state cleans itself up. Hold, transfer and supervisor features all work by adding, removing or updating conference participants instead of re-dialing.

**Realtime to the browser.** The call controller runs Socket.IO with the Redis adapter, so it can scale horizontally. Users authenticate to the socket with a short-lived JWT issued by the API. Each user's sockets are tracked in Redis (`presence:sockets:*`) so an inbound call can ring every tab and device that user has open.

**Browser softphone behavior.** The web app registers a Twilio Voice device on sign-in and refreshes its token before it expires. Do Not Disturb is a client-side setting: the device stays registered and incoming calls are rejected in the browser. Microphone access is requested before the device registers.

## Where it stands

Working today:

- Sign in, sessions, roles and permissions
- Inbound calls to department numbers, ringing every online member
- Outbound calls from the browser softphone
- Hold, mute and direct transfer to a teammate
- Call history, recordings and transcripts
- Shared SMS/MMS conversations with inbound and outbound messages
- Admin console for users, departments and phone numbers, with soft delete and restore

Planned or incomplete:

- Warm transfer, and transfer to a department or an outside number
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
- An S3-compatible bucket for MMS attachments (MinIO locally; see [Object storage](#object-storage))
- A Twilio account with a phone number, an API key and secret, and a TwiML application
- A public HTTPS URL for Twilio webhooks during development. A [Nouva.sh](https://nouva.sh/docs/tunnels) tunnel needs nothing installed: it runs over `ssh`, and the first connection prints a link to authorise in the browser

If you have Docker, the quickest way to get the databases and the bucket is the dev compose file:

```bash
docker compose -f docker-compose.dev.yml up -d
```

It starts Postgres, Redis and MinIO, and a one-shot `minio-init` container creates the `iziphone-media` bucket. These match the defaults in `.env.example`; the MinIO console is at http://localhost:9001 with the same credentials. Change the passwords for anything beyond local development.

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
2. Create a **TwiML application** and copy its SID into `TWILIO_TWIML_APP_SID`. Set its Voice request URL to the call controller's voice webhook (`${WEBHOOK_BASE_URL}/webhooks/twilio/voice/inbound`) with the HTTP POST method; the route accepts nothing else. Before the softphone dials, it asks the call controller for a grant to call that number from the line the user chose, and starts the call with the grant as its only parameter besides the `outbound-pstn` type. The webhook reads who is calling, whom and from where from the grant, because Twilio lets the browser set every other parameter of the call, `From` included. There is no deployment-wide caller ID: a call leaves from one of the caller's own lines (their number, or a number of a department they belong to) and is refused when it names no line they may use.
3. For each **phone number** you add through the admin console, point its Voice webhook at the call controller and its Messaging webhooks at the API:
   - Voice: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/inbound`
   - Voice status callback: `${WEBHOOK_BASE_URL}/webhooks/twilio/voice/status`
   - Messaging: `<api url>/webhooks/twilio/messages/inbound`
   - Messaging status callback: `<api url>/webhooks/twilio/messages/status`
4. Expose the call controller and API over HTTPS. One Nouva.sh session carries both, and each `-R` names the alias it answers on (up to five per session):

   ```bash
   ssh -R izi-calls:80:localhost:3002 \
       -R izi-api:80:localhost:3001 \
       tunnel@ssh.nouva.cloud
   ```

   That serves `https://izi-calls.nouva.cloud` and `https://izi-api.nouva.cloud` while the terminal stays open. Set `WEBHOOK_BASE_URL` to the calls alias; voice-only work needs only that first `-R`.

   Messaging and MMS need the API public as well, because Twilio fetches media from it. Point `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` at the API alias — the session cookie is issued for the API's own origin, so they must agree. Add a third `-R` for the web app on 3000 and set `CORS_ORIGIN` to it; keeping every origin under `nouva.cloud` keeps the cookie same-site.
5. Optionally set `TWILIO_HOLD_AUDIO_URL` to a public MP3 or WAV for hold music. A Twilio-hosted classical track is used when it is empty.
6. Turn on **Enforce HTTP Auth on Media URLs** in the console's Voice settings, as Twilio recommends. The API already fetches a voicemail with the account's credentials and serves the audio to the softphone itself, so nothing here relies on recording URLs being public; while the setting is off, anyone who holds a recording's URL can download it without signing in.

Every line must be a voice-capable number on this Twilio account, because Twilio accepts only the account's own (or verified) numbers as caller ID. For US calls to be signed with full STIR/SHAKEN attestation, the account also needs an approved Business Profile and a SHAKEN/STIR trust product in Trust Hub with the numbers assigned to it.

Twilio signs every webhook. Signature validation is enforced when `NODE_ENV` is anything other than `development`, and skipped in development so local tunnels are easy to work with. Never run with `NODE_ENV=development` on a public host.

## Object storage

The API keeps MMS attachments in one S3-compatible bucket and is the only service that talks to it. Six `STORAGE_*` variables select the provider; nothing else changes between them. The bucket does not need to be public: media is served through the API's `/media` routes, and Twilio fetches outbound attachments from there.

| Provider | `STORAGE_ENDPOINT` | `STORAGE_REGION` | `STORAGE_FORCE_PATH_STYLE` |
|---|---|---|---|
| MinIO (dev compose) | `http://localhost:9000` | `us-east-1` (any value) | `true` (the default with an endpoint; MinIO only answers path-style unless `MINIO_DOMAIN` is set) |
| AWS S3 | leave unset | the bucket's region, e.g. `us-east-1` | `false` (the default without an endpoint) |
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | either; the default `true` works |
| Backblaze B2 | the bucket's endpoint, `https://s3.<region>.backblazeb2.com` | the `<region>` part of the endpoint, e.g. `us-west-004` | either; the default `true` works |
| IDrive e2 | the endpoint shown for the bucket's region, `https://s3.<region>.idrivee2.com` | the `<region>` part of the endpoint, e.g. `us-west-1` | `true` |

`STORAGE_BUCKET` names the bucket, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` are the key pair, and the optional `STORAGE_KEY_PREFIX` puts every object under a prefix so a bucket can be shared. The key needs `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the bucket's objects and `s3:ListBucket` on the bucket itself: the health check asks the bucket with a `HeadBucket`, which AWS S3 and MinIO gate on that bucket-level permission, so a key with object rights alone stores media fine but reports storage as down. On another provider, confirm with `GET /health/storage` after the first deploy that the key's scope covers the bucket call too. The API validates these at boot and refuses to start without them. `GET /health/storage` and `GET /health/all` (admin only) report whether the bucket answers; the public `/health` does not depend on it.

Provider references: [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/) and its [AWS SDK JS v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/), [B2 S3-compatible API endpoints](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api) and its [AWS SDK JS v3 guide](https://www.backblaze.com/docs/cloud-storage-use-the-aws-sdk-for-javascript-v3-with-backblaze-b2), [IDrive e2 endpoint URLs](https://www.idrive.com/s3-storage-e2/e2-endpoint-urls) and its [developer guide](https://www.idrive.com/s3-storage-e2/guides/create_objects), [MinIO `MINIO_DOMAIN`](https://docs.min.io/enterprise/aistor-object-store/reference/aistor-server/settings/core/).

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
| `STORAGE_ENDPOINT` | api | S3-compatible endpoint URL. Leave unset only for AWS S3 itself |
| `STORAGE_REGION`, `STORAGE_BUCKET` | api | Region value the provider expects (`auto` for R2) and the bucket name |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | api | Key pair with read, write and delete rights on the bucket |
| `STORAGE_FORCE_PATH_STYLE` | api | `true` or `false`. Defaults to `true` when `STORAGE_ENDPOINT` is set, `false` otherwise |
| `STORAGE_KEY_PREFIX` | api | Optional prefix in front of every object key |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | api, call-controller | Account credentials and webhook signature validation. Set both or neither |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET` | call-controller | Voice token minting |
| `TWILIO_TWIML_APP_SID` | call-controller | TwiML app for outbound browser calls |
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

Tests mock Twilio, Redis, Postgres and object storage. Nothing in the test suite talks to a live service. Every test file runs in its own process, and all mocks, spies and stubbed environment variables are reset before each test (see `vitest.shared.ts`).

## Building for production

```bash
pnpm build
```

- `apps/api` and `apps/call-controller` compile to `dist/` and start with `node dist/index.js`. Both have a multi-stage `Dockerfile`.
- `apps/web` builds a standalone Next.js server (`output: 'standalone'`).

Run the API and the call controller behind an HTTPS reverse proxy, set `NODE_ENV=production`, and make sure the call controller's public URL matches `WEBHOOK_BASE_URL`. The API's `/internal/*` routes are meant for the call controller only and must not be exposed to the internet. Managed Postgres, Redis and object storage are strongly recommended over self-run instances; the API container keeps no media on its own disk.

## Costs

iziphone is free to run, but Twilio is not. You pay Twilio for phone numbers, voice minutes, recordings, transcription and messages. Check [Twilio's pricing](https://www.twilio.com/pricing) for your country before putting real traffic through the system, and watch your account during development. A misconfigured routing loop can generate charges quickly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before starting anything larger than a small fix.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

iziphone is source-available under the [PolyForm Shield License 1.0.0](LICENSE).
