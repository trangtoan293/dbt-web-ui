# A browser-based IDE for dbt

[![CI](https://github.com/trangtoan293/dbt-web-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/trangtoan293/dbt-web-ui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](./CHANGELOG.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

Open-source, self-hosted development environment for
[dbt](https://www.getdbt.com/). Edit models in a SQL-aware editor, run and build
with live streaming logs, preview results, manage Git, and configure warehouse
connections — all from the browser, all on your own infrastructure.

> **Naming notice:** `dbt-craft` is a temporary internal identifier, not an
> approved public product name. See [TRADEMARKS.md](TRADEMARKS.md).

## Try it in three commands

Needs Docker, Docker Compose, and OpenSSL. Runs in single-user mode with every
port bound to loopback, so no OIDC provider is required.

```bash
cp .env.example .env
./scripts/generate-secrets.sh   # paste the three secrets into .env
docker compose up -d            # then open http://localhost:3000
```

Database migrations apply automatically: the one-shot `db-migrate` service runs
before the frontend starts.

## Features

- **dbt IDE** — SQL and Jinja editor with dbt-aware autocomplete for models,
  sources, and macros, plus a per-project file tree.
- **Run with live logs** — `run`, `build`, `test`, `compile`, `seed`, and more,
  streamed to the browser over Server-Sent Events.
- **Preview and compile** — `dbt show` previews, compiled SQL, and an estimated
  query plan.
- **Lineage** — model dependencies read from the dbt manifest, plus generated
  dbt docs.
- **Git** — clone, commit, push, pull, branch, and diff, with per-project
  credentials stored encrypted.
- **Run history** — every run persisted with status, duration, model counts, and
  logs, queryable through a documented
  [orchestrator API](docs/external-orchestrator-api.md) for Airflow.
- **Warehouse connections** — PostgreSQL, DuckDB, Dremio, Oracle, and Apache
  Spark (Spark via a build flag), with encrypted credentials per project. Give
  each project its own DuckDB file: DuckDB allows a single writer, so two
  projects sharing one `.duckdb` will fail with a lock error.
- **Single- or multi-user** — `AUTH_DISABLED=true` for a local single-user
  install, or any OIDC provider with per-user project ownership.

## Architecture

| Component      | Stack                                          |
|----------------|------------------------------------------------|
| **frontend**   | Next.js 15 (App Router), Prisma 6, NextAuth v5 |
| **dbt-runner** | FastAPI, SQLAlchemy 2, async throughout        |
| **postgres**   | PostgreSQL 16 (application database)           |
| **redis**      | Per-project run locks + a global run semaphore  |
| **auth**       | Any OIDC provider (external; you supply the issuer) |

```
├── nextjs/         # Next.js frontend (Prisma, NextAuth)
├── dbt-runner/     # FastAPI backend (dbt execution, git, connections, SSE)
└── docker-compose.yml
```

- Frontend and dbt-runner verify the issuer's JWTs independently, using keys
  from its published `jwks_uri`.
- Project files are shared between the two through a Docker volume.
- Run streaming and file watching use Server-Sent Events — no WebSocket.

For anything network-accessible: set `AUTH_DISABLED=false`, configure OIDC, set
a strict `CORS_ORIGINS` allowlist, terminate TLS at a reverse proxy, and keep
PostgreSQL and Redis unpublished. See [SECURITY.md](SECURITY.md) and the
[production hardening guide](docs/deployment/production-hardening.md).

## Local development

Needs Node.js 20+, npm 10+, Python 3.11, and [uv](https://docs.astral.sh/uv/).
Start the data services with `docker compose up -d postgres redis`, then:

```bash
# Frontend — http://localhost:3000
cd nextjs
npm ci
npx prisma generate            # after any schema change
npm run dev
npm run lint && npm run build
npm run test                   # Vitest; needs the .env.test DB (see below)

# Backend — http://localhost:8080
cd dbt-runner
uv sync --frozen --extra test
uv run uvicorn app.main:app --reload --port 8080
uv run pytest -q
```

Frontend tests wipe their database on every test, so they require a dedicated
one — see `nextjs/scripts/setup-test-db.sh` and `nextjs/.env.test`.

## Configuration

Everything is environment variables; [`.env.example`](.env.example) is the full
list. The ones that matter:

| Variable | Purpose |
|----------|---------|
| `AUTH_DISABLED` | `true` = single-user, no login. Loopback only. |
| `POSTGRES_PASSWORD` | Password for the bundled PostgreSQL |
| `APP_ENCRYPTION_KEY` | AES key encrypting stored credentials |
| `AUTH_SECRET` | Session cookie signing secret |
| `OIDC_ISSUER` | OIDC issuer URL; endpoints come from its discovery document |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | OIDC client credentials |
| `OIDC_AUDIENCE` | Expected `aud` claim on access tokens |
| `DBT_RUNNER_URL` | Internal backend address used by the API proxy |
| `CORS_ORIGINS` | JSON origin allowlist for the backend |
| `MAX_CONCURRENT_DBT_RUNS` | Global run cap; further runs get HTTP 429 |
| `INSTALL_DBT_SPARK` | Build the runner image with dbt-spark |

Never commit your `.env` — only `.env.example` is tracked.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Third-party components keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

dbt is a trademark of dbt Labs. This independent project is not affiliated with,
sponsored by, or endorsed by dbt Labs.
