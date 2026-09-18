# Project structure

For developers. Shows where things live in the monorepo and the rule that
decides where new code goes.

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

## Module layout

Both backend apps are organized by feature, not by layer, and every module has
an `index.ts` that is its only public surface: import another module through
it, never from its files. The module-by-module map of `apps/api/src`,
`apps/call-controller/src` and `apps/web/src` is kept in
[CLAUDE.md](../../CLAUDE.md), next to the conventions that go with it, so there
is one copy of it.

## Related

- [Architecture](architecture.md)
- [Conventions and commands](conventions.md)
