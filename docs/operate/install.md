# Install and run locally

For whoever is setting up a development machine or a first stack. Covers the
prerequisites, the local infrastructure, installing the repository, and the
commands that start the three services.

## Prerequisites

- Node.js 24 LTS or newer (`.nvmrc` pins 24)
- pnpm 12 or newer (`corepack enable` installs the pinned version automatically)
- PostgreSQL 18 and Redis 8, running locally or reachable from your machine
- An S3-compatible bucket for MMS attachments (MinIO locally; see [Object storage](object-storage.md))
- A Twilio account with a phone number, an API key and secret, and a TwiML application
- A public HTTPS URL for Twilio webhooks during development. A [Nouva.sh](https://nouva.sh/docs/tunnels) tunnel needs nothing installed: it runs over `ssh`, and the first connection prints a link to authorise in the browser

## Local infrastructure

If you have Docker, the quickest way to get the databases and the bucket is the
dev compose file:

```bash
docker compose -f docker-compose.dev.yml up -d
```

It starts Postgres, Redis and MinIO, and a one-shot `minio-init` container
creates the `iziphone-media` bucket. These match the defaults in
`.env.example`; the MinIO console is at http://localhost:9001 with the same
credentials. Change the passwords for anything beyond local development.

## Installation

```bash
git clone https://github.com/<your-org>/iziphone.git
cd iziphone
pnpm install
cp .env.example .env
```

Fill in `.env`. The variables are described in
[Environment variables](environment.md).

## Running the services

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

Then create the first administrator: see
[Creating the first admin](first-admin.md).

Other useful commands:

```bash
pnpm db:studio           # Prisma Studio
pnpm build               # Build every package and app
pnpm clean               # Remove build outputs
```

## Next

- [Twilio configuration](twilio.md) — API key, TwiML application, webhooks, tunnels
- [Object storage](object-storage.md) — the bucket and its provider settings
- [Email](email.md) — optional SMTP for invite and reset links
- [Validation and upgrading](validation.md) — the checks and what to run after pulling
