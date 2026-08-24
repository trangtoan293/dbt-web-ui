# dbt-craft — Contributor Guide

Web-based dbt IDE. **Next.js 15** frontend + **FastAPI** `dbt-runner` backend +
optional **dsh-agent** assistant. PostgreSQL 16; Prisma 6 (frontend only),
SQLAlchemy 2 async (backend). Auth is generic OIDC via NextAuth v5, or
`AUTH_DISABLED=true` for a single local user.

```
nextjs/       # App Router: (app)=authenticated, (auth)=login; components-v2/, lib/, prisma/
dbt-runner/   # adapters/, ingest/, app/{routers,services,core}
dsh-agent/    # one harness session per project over SSE; dbt_mcp/, profile/, plugins/
docker-compose.yml   # postgres, redis, db-migrate, dbt-runner, frontend, dsh-agent
```

## Commands

```bash
cd nextjs && npm run dev|build|test
npx prisma migrate dev --name X && npx prisma generate   # generate is NOT a postinstall
cd dbt-runner && uv sync --frozen --extra test && uv run pytest -q
uv run uvicorn app.main:app --reload --port 8080
docker compose up -d
docker compose --profile demo up -d demo-source   # dummy CRM Postgres for trying ingest
```

## Key decisions

**Auth.** Endpoints are discovered from `{OIDC_ISSUER}/.well-known/...`
(`src/lib/oidc.ts`) — never hardcode a provider URL. `User.id` is a Prisma UUID,
not the OIDC `sub` (which lives in `User.oidcSub`). Frontend and dbt-runner
verify JWTs independently. `AUTH_TRUST_HOST=true` behind a proxy. Middleware
gates pages only; API routes do their own session check so they 401 instead of
redirecting.

**Routing.** Five sidebar sections (`/`, `/develop`, `/orchestrate`, `/explore`,
`/data`); sub-pages are tabs in the query string (`?tab=schedules`) with legacy
redirects in `next.config.ts`. `/settings` is reached from the avatar menu only.
A new page needs an entry in `components-v2/layout/navigation.ts` *and* the icon
map in `Sidebar.tsx`. Per-project configuration belongs in
`ProjectSettingsDialog.tsx`, not a new dialog.

**Query engine.** DuckDB is the only engine we run: `dbt-duckdb` executes models
and reads the DuckLake lakehouse. Postgres/Oracle/Dremio/Spark are pass-throughs.
DuckDB's defaults are wrong here (it takes ~80% of visible memory), so
`app/core/duckdb_resources.py` derives a per-run share from the cgroup limit
divided by `concurrent_engine_slots()` = `MAX_CONCURRENT_DBT_RUNS +
MAX_CONCURRENT_QUERIES`; raising concurrency shrinks every run. Adapters import
nothing from `app` — `_apply_duckdb_resources` in `dbt_service.py` is the single
call site. Spill goes to `DUCKDB_TEMP_DIR`, not next to the db file.

**Ingest & lakehouse.** `POST /sse/ingest/{source_id}` runs dlt in a subprocess
configured over **stdin, never argv** (argv leaks the warehouse password).
`ingest_sources` stores no credentials — it references a `connections` row.
Destinations: `ducklake` (default) or `connection`. The lake is DuckLake:
catalog in Postgres, Parquet on `storage-data`, one catalog per project;
`ingest/lakehouse.py` owns the layout and is shared with profile generation.
`partition_by` becomes `SET PARTITIONED BY` DDL — validated on both sides,
`lakehouse.partition_expression` enforces it.

**Iceberg publish.** `POST /lake/iceberg/{project_id}` **copies** Parquet, never
registers the lake's own files: two catalogs each running GC cannot share files
(`tests/test_iceberg_publish.py`). Keep `ICEBERG_WAREHOUSE_DIR` outside
`lakehouse.data_dir()`. A schedule's `publishSchema` is handled entirely in
`RunScheduler._publish_iceberg`; publish failures are logged, never raised. dbt
cannot write Iceberg directly (verified) — that is why Iceberg is a publish target.

**dbt assistant (dsh-agent).** Part of the stack; empty `AGENT_URL` disables it
(proxy 503s, panel hides). Model providers are per-user config in Settings
(`ai_providers` + `ai_credentials`, the harness's own settings/credentials
split); keys are never returned to the browser. The `/api/agent` proxy resolves
them server-side and **sets** `X-Model-Providers` / `X-Model-Credentials`.
dsh-agent turns them into a per-session Cordis `--patch` overlay; both are fixed
at spawn, so a change restarts the session (`ModelConfig.fingerprint`).
It edits files via the harness fs tools but runs dbt only through the `dbt` MCP
server → dbt-runner (single-writer DuckDB, warm workers, memory budget, History).
Authorization is delegated to dbt-runner (`app/authz.py`); it has no
`DATABASE_URL` and no `APP_ENCRYPTION_KEY`. The harness is **not vendored** —
`profile/cordis.patch.yml` patches the shipped bundle (a patch replaces a whole
`config`, no deep merge). Sandbox modes fence *writes*, not reads, so one
project's session can read another's files — hence off by default; see
`dsh-agent/README.md`.

**Scheduling.** `app/services/scheduler.py` is one poll loop doing three jobs:
fire due schedules, prune run history, run DuckLake maintenance. Leadership is a
Redis key with TTL (uvicorn may run several workers). A schedule arms on its
first tick, and `next_run_at` advances *before* the run starts. Cron is UTC
(`croniter`); `GET /dbt/cron/preview` validates in the form. `webhookUrl` goes
through `host_guard` on every delivery. Both the router and the scheduler start
runs via `app/services/run_launcher.py`.

**Targets.** A project's `connectionId` is always target `dev`; extras are
`project_targets` rows. Each target needs its own credential env var
(`DbtService.target_secret_env`) or the last-rendered output wins. Names are
validated by `TARGET_NAME_RE`. The frontend appends `--target` in exactly one
place: `buildDbtCommandWithArgs`.

**dbt-runner.** Async FastAPI. `GET /system/info` returns a hand-picked
whitelist — never serialise `Settings`, it holds `app_encryption_key`
(`tests/test_system_info.py`). Run control: per-project Redis lock + global
semaphore (429 when full); console queries use a separate query semaphore.
Warm worker pools are reclaimed idle-first then LRU, never mid-job.
`adapters/__init__.py` is the registry — keep it in step with `ConnectionDialog.tsx`.

## Gotchas

- `db-migrate` must complete before `frontend` starts. `STORAGE_DIR` must be the
  same path and volume in both services. Shared env lives in the
  `x-shared-env` / `x-auth-env` anchors — edit the anchor.
- Frontend tests wipe every table; `test/setup.ts` refuses a `DATABASE_URL` that
  doesn't contain "test".
- DuckDB is single-writer and warm workers hold the file: one `.duckdb` file per
  project. `_regenerate_profiles_from_db` must `release_project()` first.
- File listing returns one directory level, not a tree. `/dbt/compile` takes
  `model_path`. `dbt source freshness` maps to the `source_freshness` enum on
  both sides. SQL formatting is `sqlglot` and **refuses** rather than guesses.
- Pin the DuckLake metadata schema on both sides (`lakehouse.metadata_schema()`)
  — defaults build two catalogs over one data dir. Pin
  `data_inlining_row_limit` or rows land inside Postgres. `merge_adjacent_files`
  runs *before* expiring snapshots. `LAKE_CATALOG_URL` moves a large catalog off
  the app database. Extensions are baked into the image (`INSTALL` needs network).
- Models reach the lake only with `+database: lake`. Only dbt-duckdb can attach
  DuckLake — other warehouses should use the `connection` destination. dbt-built
  lake tables have no partition spec (`lakehouse.unpartitioned_tables` reports
  them). The attach block is added only while a `ducklake` ingest source exists.
- dlt cursors live in `STORAGE_DIR/dlt/{project_id}`.
  `INGEST_ALLOW_PRIVATE_HOSTS=true` still blocks our own Postgres/Redis.
- dsh-agent: the first prompt waits on the MCP readiness file; drain harness
  stderr in chunks; stdout is JSON-RPC (log to stderr); drop empty env values;
  the image must run npm install scripts (koffi); mount projects outside `/tmp`;
  files land 0600 (shared uid 1000). `@deepseek-ai/dsh` is a preview — pin it and
  run `plugins/dsh-session-resume/test_resume.py` after every upgrade.

## Don't

- Hardcode secrets, add RLS policies, or add analytics/telemetry.
- Add a warehouse to the UI without its dbt adapter in `pyproject.toml`.
- Accept Python source for an ingest source — configuration is declarative only.
- Skip `host_guard` on any endpoint that connects to a user-supplied host.
- Give dsh-agent database access or let it shell out to dbt.
