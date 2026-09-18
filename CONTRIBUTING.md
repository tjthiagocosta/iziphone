# Contributing to iziphone

Thanks for your interest in contributing. This project is in early/alpha development, so expect the architecture and APIs to keep changing.

## Before you start

- For anything beyond a small fix (typos, small bug fixes, docs), open an issue first to discuss the change. This avoids duplicated work and mismatched expectations, especially while the project is young.
- Keep pull requests focused. Prefer several small, reviewable PRs over one large one.

## Development setup

Follow [docs/operate/install.md](docs/operate/install.md) to get the app running locally with your own Postgres and Redis instances and your own Twilio test credentials.

## Making changes

- Match the existing code style; run `pnpm lint` and `pnpm format` before committing.
- Run `pnpm check` (lint, typecheck and tests) and make sure they pass.
- Add or update tests for any behavior change. Tests use mocked Twilio/Redis/Postgres clients where practical — do not add tests or examples that call real third-party services.
- Do not commit `.env` files, credentials, real phone numbers, real customer/contact data, call recordings, or any other private data. Use fictional data only: phone numbers in the reserved `555-01xx` range, emails at `example.com`, and made-up people and businesses.
- Do not add hardcoded default credentials or bypass authentication checks.

## Licensing of contributions

iziphone is distributed under the [PolyForm Shield License 1.0.0](LICENSE), and the copyright holder may also offer it under separate commercial terms. By submitting a contribution, you agree that:

- You have the right to submit it (it is your own work, or you are permitted to contribute it).
- You license it to the copyright holder under the same terms as the project's [LICENSE](LICENSE), and you grant the copyright holder permission to relicense it, including under commercial licenses.

If you cannot agree to this, please open an issue to discuss before submitting code.

## Commit messages / PRs

- Write clear, descriptive commit messages explaining *why* a change was made.
- Describe what you tested and how in the pull request description.

## Reporting bugs

Open an issue with steps to reproduce, expected vs. actual behavior, and relevant logs (with any sensitive values redacted).

## Security issues

Do not open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md).
