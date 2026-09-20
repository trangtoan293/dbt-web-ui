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

**Ingest.** `POST /sse/ingest/{source_id}` runs dlt in a subprocess configured
over **stdin, never argv** (argv leaks the warehouse password). `ingest_sources`
stores no credentials — it references a `connections` row, and that reference is
**nullable**: a file path and a public API have none. Three source kinds,
dispatched in `_build_source_block` (`app/routers/ingest.py`) and built in
`ingest/runner.py:_build_source`; each kind's own module validates what it may
contain — `sql_database` (`sql_source.py`: Postgres, Oracle, MySQL, one
`build_url`), `rest_api` (`rest_source.py`: configured with a **dict**, because a
Python source definition in a request body is RCE; paths cannot contain `..`,
params must be scalars, resource names must equal `tables`), `filesystem`
(`file_source.py`: CSV/JSONL/Parquet fenced to `INGEST_FILE_ROOTS`, CSV read
through duckdb). `mysql` and `rest` are connection types with **no dbt adapter**,
the same shape as `ducklake`: `build_adapter_config_from_connection_row` refuses
them as a project's warehouse with a message, and `/connection/test` plus the
table picker fall back to `sql_source.probe` / `rest_source.probe_rest`.
**`cursor_field` is the most important field on a source** — it makes dlt push
`WHERE cursor > last_value` down to the source; without one every load reads the
whole table and `merge` only dedupes afterwards. `_apply_hints` applies it for
`sql_database` and `filesystem` but not `rest_api`, which carries it
declaratively so it is actually *sent* (`incremental.start_param` names the query
parameter). Destinations: `ducklake` (default) or `connection`.

**Lakehouse.** A lake is a `connections` row of type `ducklake`, not a value
derived from a project id — that is what lets one be named, shared by several
projects, or borrowed from someone else. A project attaches one through
`dbt_projects.lakehouseConnectionId`, separate from `connectionId` because a lake
sits *beside* the warehouse. Catalog in Postgres, Parquet on `storage-data`;
`ingest/lakehouse.py` owns the layout and is shared with profile generation.
`extra_config.mode` is **managed** (this deployment created the catalog; its URL
is read from `LAKE_CATALOG_URL` at resolve time, never copied into the row, so
rotating it moves every managed lake) or **external** (every locating value is
user input). The mode is not a display flag: `provision()` refuses to pin write
options on an external lake and `destroy()` refuses one outright, both guards in
`ingest/lakehouse.py` rather than in the routers. External is read-write on
purpose — DuckLake is genuinely multi-writer; what is gated is `maintained`,
which external defaults to false. Four external-mode checks
(`app/services/lakes.py`, covered by `tests/test_lakehouse_connections.py`):
`assert_host_allowed` at save *and* resolve time (without it a lake aimed at our
own Postgres reads every user's `password_encrypted` through ordinary model SQL),
`validate_metadata_schema` (the name is concatenated into `ATTACH`, no bound
parameter), `validate_data_path` (refuses inside `LAKE_DATA_DIR` and any local
path outside `LAKE_EXTERNAL_DATA_ROOTS`), and an existence check *before*
attaching (attaching creates the metadata schema, so a typo would leave a stray
catalog and report success). Maintenance runs once per lake, not once per
project. `partition_by` becomes `SET PARTITIONED BY` DDL — validated on both
sides, `lakehouse.partition_expression` enforces it. `+database: lake` is set
from `LakehousePanel`, edited as lines because `dbt_project.yml` ships full of
comments that a YAML round trip would delete.

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
The same panel is docked in **Explore** (`AgentPanel` takes `title`/`intro`/
`placeholder` and an `attachment`), where the job is reading built data and
writing boards rather than editing models. That difference is carried *per
prompt* — `lib/explore-agent.ts` builds the brief and names what is on screen —
not by a second persona: the profile's persona is fixed at session spawn.
Authorization is delegated to dbt-runner (`app/authz.py`); it has no
`DATABASE_URL` and no `APP_ENCRYPTION_KEY`. The harness is **not vendored** —
`profile/cordis.patch.yml` patches the shipped bundle (a patch replaces a whole
`config`, no deep merge). Sandbox modes fence *writes*, not reads, so one
project's session can read another's files — hence off by default; see
`dsh-agent/README.md`.

**Dashboards.** A board is a YAML file under `charts/`, and that file *is* the
published dashboard - there is no snapshot table. `DashboardWorkspace` therefore
has two modes: **view** renders the saved file (`baseline`) and does it on open,
so a reader clicks a dashboard and sees results without pressing Preview;
**edit** renders the unsaved buffer (`yaml`), which is the draft. Publish is
`filesApi.save` plus a switch back to view - the draft lives in the editor and
in localStorage, so there is no third copy to reconcile. The auto-render is
gated on the `active` prop because Explore keeps every section mounted, and a
hidden board must not run warehouse queries. A chart is built in exactly one
component, `ChartBuilder` — SQL results and a dashboard's Add chart both mount
it, so a chart is always drawn before it is committed anywhere. It redraws
without a Build button because `/charts/render` draws from rows the browser
already holds (no warehouse round trip); `chartProblem` states the renderer's
limits up front instead of failing on them. Add chart still inserts the *query*,
never these rows, so the dashboard refreshes. Helpers and their tests:
`boardSource` / `boardNeedsRender` / `chartProblem` in `src/lib/board.ts`.

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
  them). The attach block is added only for a project with a lakehouse attached,
  and only on its DuckDB targets — the refusal belongs *after* the target loop,
  or one Dremio target fails the whole profile.
- dlt cursors live in `STORAGE_DIR/dlt/{project_id}`.
  `INGEST_ALLOW_PRIVATE_HOSTS=true` still blocks our own Postgres/Redis.
- dlt's two incremental shapes are not interchangeable: the endpoint form takes
  `start_param` and **rejects** `type`, the parameter form requires `type` and
  has no `start_param`. Mixing them fails only at load time, which is why the
  REST source has an end-to-end test against a real HTTP server.
- A source with no `cursor_field` re-reads everything every run — not a tuning
  knob at core-banking size. Empty `INGEST_FILE_ROOTS` turns the filesystem
  source off, deliberately: dbt-runner can read anywhere its uid reaches. A
  `rest` connection keeps its hostname in `host` so the host guard has the same
  thing to check as every other type (`rest_source.validate_base_url`).
- dsh-agent: the first prompt waits on the MCP readiness file; drain harness
  stderr in chunks; stdout is JSON-RPC (log to stderr); drop empty env values;
  the image must run npm install scripts (koffi); mount projects outside `/tmp`;
  files land 0600 (shared uid 1000). `@deepseek-ai/dsh` is a preview — pin it and
  run `plugins/dsh-session-resume/test_resume.py` after every upgrade.

## Don't

- Hardcode secrets, add RLS policies, or add analytics/telemetry.
- Add a warehouse to the UI without its dbt adapter in `pyproject.toml`.
  `mysql`, `rest` and `ducklake` are the exception: read-only ingest types with
  no adapter on purpose, refused as a warehouse with a message.
- Accept Python source for an ingest source — configuration is declarative only.
- Skip a host guard on any endpoint that connects to a user-supplied host:
  `app/core/host_guard.py` in dbt-runner, `src/lib/host-guard.ts` in the
  frontend (a provider's Base URL is fetched by the server too).
- Give dsh-agent database access or let it shell out to dbt.
