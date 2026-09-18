# Conventions and commands

For developers. The commands you will run every day and the conventions a
change is expected to follow.

## Commands

```bash
pnpm install             # install the workspace
pnpm dev                 # build the shared packages, then run all three services
pnpm db:push             # apply the Prisma schema and generate the client
pnpm db:studio           # Prisma Studio
pnpm build               # build every package and app
pnpm clean               # remove build outputs
pnpm lint                # Biome: lint + format check
pnpm lint:fix            # apply Biome's fixes
pnpm typecheck           # tsc --noEmit in every app
pnpm test                # Vitest in every workspace
pnpm check               # lint, typecheck and test
```

Turbo builds the shared packages before `dev`, `test` and `typecheck` run,
because every shared package exports only its compiled `dist/` and the apps use
TypeScript project references to it. Running `tsc` or `vitest` directly inside
an app on a fresh clone fails until the packages are built; go through the root
scripts. Task results are cached, so a second `pnpm check` with no changes is
instant.

## Conventions

The conventions themselves — TypeScript and ESM rules, the `.js` extension on
relative imports, the strict compiler settings, Biome, where Zod schemas live,
thin routes over services, audit entries on admin mutations, channel names from
`packages/events`, the signature-validation preHandler on every Twilio webhook,
and the data and privacy rules for tests and fixtures — are kept in
[CLAUDE.md](../../CLAUDE.md), which both people and coding assistants read.

## Related

- [Testing](testing.md)
- [Contributing](contributing.md)
- [Validation and upgrading](../operate/validation.md)
