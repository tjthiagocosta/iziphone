# Contributing

For anyone sending a change. Points at the full policy and states the one rule
worth knowing before you start.

Open an issue before starting anything larger than a small fix. The project is
in early development, so the architecture and the APIs keep changing, and an
issue first avoids duplicated work.

The full policy — development setup, what a change must ship with, the data and
privacy rules, how contributions are licensed, commit messages and bug reports
— is in [CONTRIBUTING.md](../../CONTRIBUTING.md) at the repository root.

This is a focused product, not a platform. Multi-tenancy, a second permissions
system and a different provider abstraction are out of scope without an issue
discussing it first; prefer fixing the existing path over adding a parallel
one.

Document your change in the `docs/` page its audience reads, not in the README.
A decision that is not obvious from the code gets a record in
[docs/decisions/](../decisions/README.md).

## Related

- [Conventions and commands](conventions.md)
- [Testing](testing.md)
- [Reporting a security issue](security.md)
