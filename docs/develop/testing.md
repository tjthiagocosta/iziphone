# Testing

For developers. What the test suite covers, how to run part of it, and the one
rule about third-party services.

```bash
pnpm test                                        # every workspace
pnpm --filter @repo/api exec vitest              # one workspace, watch mode
pnpm --filter @repo/api exec vitest run src/auth/auth.routes.test.ts   # one file
```

On a fresh clone, build the shared packages first:
`pnpm turbo run build --filter='./packages/*'`.

Tests live next to the code as `*.test.ts` and use Vitest. Tests mock Twilio,
Redis, Postgres and object storage. **Nothing in the test suite talks to a live
service**, and nothing may be added that does. Every test file runs in its own
process, and all mocks, spies and stubbed environment variables are reset
before each test (see `vitest.shared.ts`), so no test may rely on state left by
another.

Route tests use the helpers in `apps/*/src/test/route-test-helpers.ts`.

Use only fictional data: phone numbers in the reserved 555-01xx range, emails
at `example.com`, made-up people and businesses.

## Related

- [Conventions and commands](conventions.md)
- [Validation and upgrading](../operate/validation.md)
