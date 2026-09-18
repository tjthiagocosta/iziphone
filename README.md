# iziphone

An open source business phone system for teams, powered by Twilio.

Own your phone system. iziphone runs on your own server and your own Twilio account, so your numbers, call history, recordings and messages stay with you. You pay Twilio for the calls and texts you actually make, and nothing per seat.

> **Status: early alpha.** Several core features work end-to-end, but the project is not production-ready. Expect breaking changes, gaps, and rough edges. See [Where it stands](#where-it-stands) before relying on it.

## Who it is for

Teams that want a browser softphone, shared numbers and shared text inboxes
without a per-seat contract. One dedicated stack per customer, running on that
customer's own Twilio account: single-organization by design, with no
multi-tenancy.

Agents make and receive calls from the web app with the Twilio Voice SDK — no
desk phones, no desktop client — and inbound calls to a number ring the members
of its department. Every call is a Twilio conference, so hold and transfer behave
the same inbound and outbound. Text conversations are per number and shared
across the team, with STOP keyword suppression; attachments callers send are
shown in the thread, and sending one from the web app is not there yet. Calls can
be recorded and transcribed through Twilio, with playback restricted by role. An
admin console manages users, departments, phone numbers and the three roles
(`ADMIN`, `SUPERVISOR`, `AGENT`), and shows basic call statistics.

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

The API owns the database and all business logic. The call controller owns
Twilio's voice webhooks and everything time-sensitive on a live call, and never
touches the database. Redis carries call events, the routing cache and the
Socket.IO adapter between them. Full picture:
[docs/develop/architecture.md](docs/develop/architecture.md).

## Quickstart

Node 24 LTS, pnpm 12, Docker, and a Twilio account.

```bash
git clone https://github.com/<your-org>/iziphone.git
cd iziphone
pnpm install
cp .env.example .env                                  # then fill it in
docker compose -f docker-compose.dev.yml up -d         # Postgres, Redis, MinIO
pnpm db:push
pnpm dev                                               # web :3000, api :3001, controller :3002
pnpm --filter @repo/api bootstrap-admin --email admin@example.com
```

The last command prints a single-use link to choose your password. The rest —
Twilio webhooks, the bucket, the tunnel for local webhooks, every environment
variable — is in [docs/operate/](docs/operate/install.md).

## Where to go next

- **Running a stack:** [docs/operate/](docs/operate/install.md) — install, Twilio, object storage, email, deployment, environment variables
- **Administering one:** [docs/admin/](docs/admin/users-and-invites.md) — users and invites, departments and routing, voicemail greeting, recording retention, roles
- **Using it:** [docs/use/](docs/use/softphone.md) — the softphone, voicemail and recordings, messaging
- **Changing the code:** [docs/develop/](docs/develop/architecture.md) — architecture, structure, conventions, testing, costs
- **Why things are the way they are:** [docs/decisions/](docs/decisions/README.md)

The index of every page is [docs/README.md](docs/README.md).

## Where it stands

Working today: sign in, sessions, roles and permissions; inbound calls to
department numbers, ringing every online member; outbound calls from the browser
softphone; hold, mute and direct transfer to a teammate; call history, recordings
and transcripts; shared SMS/MMS conversations with inbound and outbound messages;
and the admin console for users, departments and phone numbers, with soft delete
and restore.

Planned or incomplete: warm transfer, and transfer to a department or an outside
number; mobile apps; call queues with wait positions and callbacks; IVR menus;
multi-tenant hosting (the system is single-organization by design); automated
database migrations (the schema is applied with `prisma db push` for now);
deployment configuration (Dockerfiles exist for `api` and `call-controller`, but
there is no production compose file or reference deployment yet —
`docker-compose.dev.yml` runs Postgres, Redis and MinIO for local development).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before starting anything larger than a small fix.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

iziphone is open source under the [MIT License](LICENSE).
