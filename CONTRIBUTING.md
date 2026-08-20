# Contributing

Thanks for your interest in contributing! This guide covers how to get set up
and the conventions we follow.

## Getting started

1. Fork and clone the repo.
2. Copy `.env.example` to `.env` and fill the secrets with
   `./scripts/generate-secrets.sh`. `AUTH_DISABLED=true` is the default and
   needs no OIDC provider.
3. Start the stack with `docker compose up -d`, or run each service on the host
   (see "Local development" in the [README](README.md)).

## Development workflow

- Create a feature branch off `main`: `git checkout -b feat/my-change`.
- Keep changes focused. One logical change per PR.
- Match the existing code style of the file you're editing.

### Frontend (nextjs)

```bash
cd nextjs
npm ci
npx prisma generate
npm run lint
npm run build         # type-check + production build
npm run test:setup    # create the dedicated test database, once
npm run test          # Vitest
```

### Backend (dbt-runner)

```bash
cd dbt-runner
uv sync --frozen --extra test
uv run python -m pytest -q
```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add duckdb connection support
fix: handle empty manifest in compile
docs: clarify oidc setup
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `chore`, `perf`, `ci`.

## Pull requests

- Describe what changed and why.
- Make sure lint, builds, and all relevant tests pass.
- Don't commit secrets or `.env` files.
- Add or update tests for behavior changes.

## Developer Certificate of Origin

This project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
instead of a contributor license agreement. Every commit must include a
`Signed-off-by` trailer certifying that you have the right to submit the work
under this project's license.

Create a signed-off commit with:

```bash
git commit -s -m "feat: describe the change"
```

The trailer must use your real name and an email address you control:

```text
Signed-off-by: Your Name <you@example.com>
```

If a pull request contains commits without this trailer, amend or rebase those
commits before merge. Do not sign off code copied from a source whose license is
unknown or incompatible.

## Reporting issues

Open an issue with steps to reproduce, expected vs. actual behavior, and your
environment (OS, Docker version, browser). For security issues, please report
privately rather than opening a public issue.

Questions and usage help belong in GitHub Discussions when enabled; see
[SUPPORT.md](SUPPORT.md). Security reports follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
