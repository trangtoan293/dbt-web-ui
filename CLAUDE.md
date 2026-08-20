# dbt-craft — Contributor Guide

Web-based dbt IDE. Two application services: a **Next.js 15** frontend and a
**FastAPI** (`dbt-runner`) backend. Auth is **generic OIDC** (NextAuth v5),
or `AUTH_DISABLED=true` for a single local user. Database is **PostgreSQL 16**.
ORM is **Prisma 6** (frontend only); the backend uses **SQLAlchemy 2 async**.

## Repo layout

```
├── nextjs/              # Next.js 15 + Prisma + NextAuth
│   ├── src/app/         # App Router: (app) authenticated, (auth) login
│   ├── src/components-v2/
│   ├── src/lib/
│   └── prisma/          # schema.prisma + migrations/
├── dbt-runner/          # FastAPI backend
│   ├── adapters/        # warehouse connection adapters
│   └── app/
│       ├── routers/     # API route handlers
│       ├── services/    # business logic
│       └── core/        # config, OIDC JWT middleware
└── docker-compose.yml   # postgres, redis, db-migrate, dbt-runner, frontend
```

## Key technical decisions

### Auth
- Generic OIDC via `next-auth` v5 (`auth.config.ts`). Endpoints come from
  `{OIDC_ISSUER}/.well-known/openid-configuration` — see `src/lib/oidc.ts`.
  Never hardcode a provider's URL template.
- `User.id` is a Prisma-generated UUID, **not** the OIDC `sub` (avoids
  cross-device login conflicts). The `sub` lives in `User.oidcSub`.
- Frontend and dbt-runner verify the issuer's JWTs independently. dbt-runner uses
  `PyJWT[crypto]` and requires an exact JWKS `kid` match.
- `AUTH_TRUST_HOST=true` is required behind a reverse proxy.
- Middleware (`nextjs/src/middleware.ts`) only gates pages. API routes do their
  own session checks and are excluded from the matcher so they return 401 JSON
  instead of redirecting.

### Routing
- Route groups: `src/app/(app)/` is the authenticated app (`/`, `/develop`,
  `/runs`, `/explore`, `/connections`, `/settings`), `src/app/(auth)/` is
  `/login` and `/logout`. One root layout, in `src/app/layout.tsx`.

### Database
- PostgreSQL 16. Migrations run via the one-shot `db-migrate` service before the
  frontend starts.
- dbt-runner connects via SQLAlchemy async + asyncpg.

### Storage
- Files are shared between frontend and dbt-runner via the Docker volume
  `storage-data` mounted at `/data/storage`.
- `APP_ENCRYPTION_KEY` encrypts sensitive credentials stored in the DB.

### Realtime (SSE, not WebSocket)
- dbt run streaming: `POST /sse/dbt/{project_id}`. File watching:
  `GET /sse/files/{project_id}`. Both in `app/routers/sse.py`.
- Frontend consumes via `fetch` + `ReadableStream` (`useDbtRunStream`) and
  `EventSource` (`useFileWatcher`).

### dbt-runner
- FastAPI + uvicorn, async throughout.
- Routers: `health, process, dbt, git, files, connection, project, sse, dremio,
  client_logs`.
- Two layers of run control: a per-project Redis lock and a global Redis
  semaphore (`MAX_CONCURRENT_DBT_RUNS`, returns HTTP 429 when full).
- Adapters: postgresql, duckdb, dremio, oracle, and spark (spark installs via
  the `INSTALL_DBT_SPARK` build arg). `adapters/__init__.py` is the registry —
  keep it in step with the connection form in `ConnectionDialog.tsx`. Offering a
  warehouse whose dbt plugin is not in the image only produces failed runs.

## Common commands

### Frontend
```bash
cd nextjs
npm run dev          # dev server :3000
npm run build
npm run test         # Vitest
npx prisma migrate dev --name <name>   # new migration
npx prisma generate  # after schema change
```

### Backend
```bash
cd dbt-runner
uv sync --frozen --extra test
uv run uvicorn app.main:app --reload --port 8080
uv run pytest -q
```

### Docker
```bash
docker compose up -d
docker compose logs -f dbt-runner
docker compose run --rm db-migrate npx prisma migrate deploy
```

## Gotchas

- `prisma generate` is **not** a postinstall script — run it explicitly after
  schema changes.
- `db-migrate` must complete before `frontend` starts (enforced via
  `depends_on: condition: service_completed_successfully`).
- `STORAGE_DIR` must be the same path in both `frontend` and `dbt-runner` and
  backed by the same volume.
- dbt-runner file endpoints validate project ownership — requests without a
  valid JWT, or for another user's project, return 403.
- Frontend tests wipe every table in `beforeEach`; `test/setup.ts` refuses to run
  unless `DATABASE_URL` names a database containing "test".
- Shared env in `docker-compose.yml` comes from the `x-shared-env` /
  `x-auth-env` YAML anchors — edit the anchor, not each service.
- DuckDB is single-writer and `warm_worker_pool` keeps project-scoped dbt
  processes alive, so a `.duckdb` file stays locked by its project. Two projects
  pointing at one file fail with `could not set lock on file`. One file per
  project.
- The file listing endpoint returns one directory level (`{path, items[]}`), not
  a recursive tree — walk down a level at a time.
- `/dbt/compile` takes `model_path`, not `file_path`.

## What NOT to do

- Don't hardcode secrets — use `.env`, never committed.
- Don't add database RLS policies — auth/ownership is enforced in application code.
- Don't add third-party analytics or telemetry. This is self-hosted software.
- Don't add a warehouse to the connection UI without adding its dbt adapter to
  `dbt-runner/pyproject.toml`.
