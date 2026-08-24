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
│   ├── ingest/          # dlt ingest: sources, destinations, DuckLake layout
│   └── app/
│       ├── routers/     # API route handlers
│       ├── services/    # business logic
│       └── core/        # config, OIDC JWT middleware
├── dsh-agent/           # the dbt assistant (optional service)
│   ├── app/             # FastAPI: one harness session per project, over SSE
│   ├── dbt_mcp/         # MCP server exposing dbt-runner to the agent
│   ├── profile/         # DeepSeek Harness profile patch layer
│   └── plugins/         # dsh-session-resume
└── docker-compose.yml   # postgres, redis, db-migrate, dbt-runner, frontend,
                         # dsh-agent (profile: agent)
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
  `/orchestrate`, `/explore`, `/data`, `/settings`),
  `src/app/(auth)/` is `/login` and `/logout`. One root layout, in
  `src/app/layout.tsx`.
- The sidebar carries the five *workspace* sections only. `/orchestrate` hosts
  Runs and Schedules, `/data` hosts Connections, Sources and Lakehouse, each as a tab whose
  id is in the query string (`?tab=schedules`) so the retired paths can redirect
  into them — those redirects live in `next.config.ts` and are covered by a
  test. `/settings` deliberately has **no** sidebar slot; it is reached from the
  avatar menu, and `navigation.ts` keeps it in `SECONDARY_PAGES` only so the top
  bar can still label it.
- Adding a page means adding it to `components-v2/layout/navigation.ts` **and**
  the icon map in `Sidebar.tsx`; a missing icon renders an empty slot rather
  than failing the build (covered by a test).
- Anything scoped to one project belongs in
  `components-v2/develop/settings/ProjectSettingsDialog.tsx`, not in a new
  dialog hung off the IDE chrome. Name, connection, targets, env vars and delete
  used to be seven separate controls spread across the toolbar, the project menu
  and the right rail, so no screen showed a project's configuration as a whole.
  Picking a target stays on the toolbar (`TargetSelector`) because that is a
  property of the next run; managing the list of targets is configuration.

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

### Query engine
- **DuckDB is the query engine**, and the only one this application runs itself:
  `dbt-duckdb` executes models, and the DuckLake lakehouse is read through the
  same engine. `postgresql`, `oracle`, `dremio` and `spark` are pass-throughs -
  dbt pushes SQL to a warehouse someone else operates.
- Single-node is not the same as small. A query over a few TB of Parquet reads
  the columns and partitions it needs, so what bounds it is disk throughput and
  the partition layout, not the engine. Put the lake on local NVMe.
- Every dbt run is a separate process with its own DuckDB instance, so DuckDB's
  own defaults are wrong here: unbounded it takes ~80% of visible memory, and
  `MAX_CONCURRENT_DBT_RUNS` of those over-commit the box until the kernel kills
  one mid-run instead of DuckDB spilling. `app/core/duckdb_resources.py` derives
  a per-run share from the container's cgroup limit divided by that concurrency,
  and `DuckDBAdapter.generate_profiles_yml` renders it as a `settings:` block.
  Raising the concurrency shrinks every run's memory - the two cannot be tuned
  apart. `MAX_CONCURRENT_QUERIES` counts towards it too:
  `duckdb_resources.concurrent_engine_slots()` is `runs + queries`, because a
  console query is a DuckDB instance doing work just as a run is. Dividing by
  runs alone left queries uncounted, so N projects querying at once meant N
  unbounded instances.
- Adapters import nothing from `app`, so the numbers are computed in
  `duckdb_resources` and passed in as adapter config. `_apply_duckdb_resources`
  in `dbt_service.py` is the one call site every generated profile passes.
- Spill goes to `DUCKDB_TEMP_DIR` (per project), not DuckDB's default of
  `<db file>.tmp`: that path is inside the dbt project volume, which is not the
  volume sized for data.

### Ingest (dlt) and the lakehouse
- `POST /sse/ingest/{source_id}` runs one load and streams it. dlt executes in a
  subprocess (`python -m ingest.runner`) whose configuration arrives on **stdin**,
  never argv: it carries a decrypted warehouse password and argv is readable via
  `ps`.
- An `ingest_sources` row stores no credentials. It references a `connections`
  row, so a warehouse password still lives in exactly one table.
- Destinations: `ducklake` (default) or `connection` (the project's own DuckDB or
  Postgres). Dremio, Oracle and Spark have no dlt destination - those projects
  ingest into the lakehouse and read it from dbt.
- The lakehouse is DuckLake: catalog tables in Postgres, Parquet on the
  `storage-data` volume, one catalog per project. `ingest/lakehouse.py` owns the
  layout and is shared with dbt profile generation.
- Ingest counts against the same `global_run_semaphore()` as dbt runs, and takes
  the `dbt_run` file lock when (and only when) it writes a DuckDB file.
- An ingest source may carry `partition_by` (a column, or
  `year|month|day|hour(column)`). It becomes DuckLake `SET PARTITIONED BY` DDL,
  so it is an expression rather than a bound parameter and is validated on both
  sides - `lakehouse.partition_expression` is the enforcing one. Applied after
  the load, because the table does not exist before it, which means the first
  load's files stay unpartitioned until maintenance merges them.
- Each load writes an `ingest_runs` row. Row counts come from the runner's
  `row_counts` field (`ingest/runner.py`); logs are a capped tail
  (`INGEST_RUN_LOG_MAX_CHARS`), because dlt is chatty and unbounded log text is
  what makes a history table the reason Postgres grows.

### Publishing the lake as Iceberg
- `POST /lake/iceberg/{project_id}` (`app/routers/lake.py`) replaces a project's
  Iceberg tables from one of its lake schemas. This is the way *out* of DuckLake:
  dbt keeps building marts in the lake, and everything that is not DuckDB - Spark,
  Trino, Athena - reads the Iceberg copy.
- **The Parquet is copied, not registered in place.** Registering the lake's own
  files costs no rewrite, but `merge_adjacent_files` then `cleanup_old_files`
  rewrites and deletes them, and DuckLake cannot see an Iceberg table pointing at
  them - the published table fails with `FileNotFoundError`. Two catalogs each
  running their own garbage collector cannot share files
  (`tests/test_iceberg_publish.py` proves it both ways). Copying is affordable
  because marts are aggregates.
- `ICEBERG_WAREHOUSE_DIR` must stay **outside** `lakehouse.data_dir()`, for the
  same reason in reverse: `ducklake_delete_orphaned_files` scans the lake's
  DATA_PATH and would find these copies unreferenced.
- A schedule may carry `publishSchema`: the scheduler publishes that lake schema
  after the run, and `RunScheduler._publish_iceberg` owns the whole decision -
  it returns early unless the schedule asked for it *and* the run succeeded, so
  no caller can forget the guard. A publish failure is logged, never raised: the
  run did succeed and the models are in the lake, so failing it would be a lie.
- A re-publish after an append copies only the new files; a rebuilt table (dbt's
  `table` materialization) or one whose files maintenance rewrote is fully
  replaced, because a file set that is not a superset of what was published has
  no honest delta. Unchanged means zero copying.
- The catalog is a pyiceberg `SqlCatalog`, i.e. an Iceberg **JDBC** catalog, so
  Trino (`iceberg.catalog.type=jdbc`) and Spark read it with no extra service.
  `iceberg.CATALOG_NAME` is part of pyiceberg's table key - a table written under
  one catalog name is invisible under another, so everything opens the catalog
  through `iceberg.catalog()`.
- **dbt cannot write Iceberg directly, verified.** DuckDB does write Iceberg
  through a REST catalog (`CREATE TABLE`/`INSERT`/`UPDATE`/`DELETE` all work), but
  dbt's `view` materialization hits `Not implemented Error: Create View`, and its
  `table` materialization hits `This table (x__dbt_tmp) was modified already,
  can't be renamed!` - DuckDB-Iceberg refuses to rename a table modified inside
  the same open transaction, which is exactly what dbt does. Only `incremental`
  works. That is why the lake stays DuckLake and Iceberg is a publish target.

### The dbt assistant (dsh-agent)
- Part of the stack: `docker compose up -d` starts it, and the frontend's
  `AGENT_URL` defaults to the compose service exactly as `DBT_RUNNER_URL` does -
  an internal address is not user configuration. Setting `AGENT_URL` **empty**
  turns the feature off: the proxy answers 503 and the panel hides itself.
- **Model providers belong to the user, configured in Settings, and follow the
  harness's own model.** `ai_providers` holds one row per route in the exact
  shape `llm-pi-ai` takes (a catalog route needs only a credential reference; a
  gateway pi-ai does not ship declares `api`, `baseURL` and `models`), and
  `ai_credentials` holds the secrets keyed by that reference - the same
  settings/credentials split the harness keeps. Any provider is therefore
  configuration, not a code change.
- Reads are write-only to the browser: `GET /api/ai-providers` reports each
  route and whether a key is stored for it, never the key.
- The configuration reaches the agent in exactly one place: the `/api/agent`
  proxy route resolves it server-side (`src/lib/ai-providers.ts`) and attaches
  `X-Model-Providers` (the adapter dict) and `X-Model-Credentials` (the secrets),
  base64-encoded, plus the chosen route and model. The browser never holds a
  secret, dsh-agent still has no database access, and the proxy **sets** those
  headers so a client cannot choose them.
- dsh-agent turns the dict into a **per-session Cordis patch overlay**
  (`--patch`) and the secrets into that process's environment, then initializes
  on the chosen route. Per session, not per home: one user's routes never reach
  another's process.
- Both are fixed at spawn, so a change restarts the session -
  `SessionRegistry.acquire` compares `ModelConfig.fingerprint`, which hashes the
  secrets rather than holding them. The conversation survives in the session log.
- A deployment-wide `DEEPSEEK_API_KEY` remains a fallback for users who
  configured nothing; `GET /health` reports whether that fallback exists, and the
  panel points at Settings when neither is present.
- **The harness's own UI gets the same configuration**, mirrored into its
  `settings.yaml` (routes, merged with what that UI stored itself) and
  `.credentials.yaml` (secrets) - but only with `AUTH_DISABLED`, since that
  surface has no authentication and its documents are shared. Do not pass it
  `DEEPSEEK_*` variables: the harness ranks the inherited environment above its
  own credential file, and compose writes an empty string for an unset variable,
  which reads as "configured with nothing" and leaves that UI asking for a key it
  already has.
- **Its own container on purpose.** dbt-runner divides *its* cgroup limit among
  DuckDB runs; a harness session is a long-lived Node process with a model
  context, and spending memory dbt-runner cannot see breaks that arithmetic.
- The harness is **not vendored**. `dsh-agent/profile/cordis.patch.yml` is a
  patch layer over the shipped `@deepseek-ai/dsh-base` bundle. A patch replaces
  a row's whole `config` - there is no deep merge - and
  `dsh --profile dbtcraft --dump-config` is run during the image build so a
  patch naming a row that does not exist fails the build, not the first request.
- **The agent edits files directly but never runs dbt itself.** Files come from
  the harness's own fs tools, fenced to the project directory. dbt goes through
  the `dbt` MCP server, which calls dbt-runner: DuckDB is single-writer, a warm
  worker holds the project's file open, and per-run memory is budgeted, so a
  shell `dbt run` would either fail on the lock or over-commit the box. Going
  through dbt-runner also puts the run in History like any other.
- Authorization is **delegated**: `app/authz.py` asks dbt-runner for something
  project-scoped with the caller's own bearer. This service never gets
  `DATABASE_URL` or `APP_ENCRYPTION_KEY`, so a second copy of ownership rules
  cannot drift from the first.
- The MCP shim reads its bearer from a file on every call, not from its
  environment: it is spawned once per session while the token expires during it.
- **The SDK wire has no cancel and no session close**, so Stop kills the process
  and one session is one process. That is only survivable because
  `plugins/dsh-session-resume` routes a persisted session id to
  `ctx.agents.resume()` - `dsh-sdk-jsonrpc-server` only ever calls `create()`,
  which fails on a session that already has a log on disk and silently drops the
  prompt. The same plugin refuses an id persisted under another working
  directory, because the id arrives from an out-of-process caller.
- Sessions are capped and reclaimed (`AGENT_MAX_SESSIONS`,
  `AGENT_IDLE_SECONDS`), idle first, then least recently used, never a busy one -
  the same shape as `warm_worker_pool`.
- **The agent container mounts the projects volume outside `/tmp`**
  (`/workspace/dbt-projects`, not dbt-runner's `/tmp/dbt-projects`). The harness
  sandbox's `workspace-write` mode grants the session's own directory *plus*
  `/tmp`, so projects under `/tmp` would be writable from every other project's
  session. Verified both ways.
- **A file the agent creates is mode 0600, and that is the harness's choice**
  (`fs-local` opens a new file `0o600` and preserves an existing file's mode when
  replacing it). It works here only because dsh-agent and dbt-runner share uid
  1000, which is why the agent container reuses that uid rather than creating one.
  Changing the umask does not move it - the mode is explicit in the harness.
- **Sandbox modes fence writes, not reads.** A session cannot write outside its
  project, but it can read another project's files: one container serves every
  project, and dbt-runner shares its uid so file permissions cannot separate
  them either. That is why the assistant is off by default. See
  `dsh-agent/README.md` for the two ways to close it (a container per project, or
  a mount namespace per session).

### Scheduling, notifications and retention
- `app/services/scheduler.py` is one asyncio poll loop doing three jobs: fire due
  `dbt_schedules` rows, prune run history past `RUN_HISTORY_RETENTION_DAYS`, and
  run DuckLake maintenance. State lives in Postgres (`next_run_at`), so a restart
  loses nothing.
- Exactly one process works at a time: leadership is a Redis key with a TTL the
  leader refreshes, because uvicorn can run several workers
  (`DBT_RUNNER_UVICORN_WORKERS`). Without Redis it still runs and logs that it is
  leaderless - two leaderless workers would double-fire every schedule.
- A schedule is armed on its first tick, not on save, so creating one never fires
  it immediately. `next_run_at` is advanced *before* the run starts: a crash
  between the two skips one run, the other order re-fires forever.
- Cron is UTC and parsed by `croniter`. `GET /dbt/cron/preview` is what the form
  uses to validate, so a typo is caught while saving rather than silently never
  running.
- A schedule's `webhookUrl` is a user-supplied URL the server POSTs to, i.e. the
  same SSRF surface as a connection host - `app/services/notify.py` puts it
  through `host_guard` before every delivery. One payload carries `text` (Slack,
  Teams), `content` (Discord) and a structured `run` object.
- Both `/dbt/runs` and the scheduler start runs through
  `app/services/run_launcher.py`. Anything that needs "run this project and tell
  me how it ended" belongs there, not in a router.

### Environments (targets)
- A project's own `connectionId` is always target `dev`. Extra targets are
  `project_targets` rows, each pointing at another Connection the same user owns,
  and `_regenerate_profiles_from_db` renders one profiles.yml output per target
  via that connection's own adapter.
- **Each target needs its own credential env var.** `DbtService.target_secret_env`
  suffixes the name (`..._CREDENTIAL__PROD`); sharing one would mean whichever
  output is rendered last wins and the other target authenticates against its
  warehouse with the wrong password.
- Target names are validated against `TARGET_NAME_RE` on both sides: the name
  becomes a profiles.yml key, a `--target` argument and an env var suffix.
- The frontend appends `--target` in exactly one place,
  `buildDbtCommandWithArgs` - a per-caller append leaves whichever path was
  forgotten silently on `dev`.

### dbt-runner
- FastAPI + uvicorn, async throughout.
- Routers: `health, process, dbt, git, files, connection, ingest, lake, project,
  sse, dremio, client_logs, system`.
- `GET /system/info` is what the Settings page reads. It returns a **hand-picked
  whitelist** of `Settings` fields and must never serialise the settings object:
  that object also holds `app_encryption_key`, which decrypts every stored
  warehouse password (`tests/test_system_info.py` fails if a secret leaks in).
- Two layers of run control: a per-project Redis lock and a global Redis
  semaphore (`MAX_CONCURRENT_DBT_RUNS`, returns HTTP 429 when full). Ad-hoc
  console queries take `global_query_semaphore` (`MAX_CONCURRENT_QUERIES`) - a
  separate pool, so a console stays usable during a batch.
- The per-project `query` file lock applies to the **subprocess fallback only**
  (`_run_dbt_command(fallback_lock=...)`). What it protects against is two dbt
  processes opening one DuckDB file, and the warm-worker path cannot do that: a
  project has one pool, so its jobs queue inside it. Holding it across both paths
  added a second serialisation layer and a 30-second failure that the pool's own
  queue reports better.
- Warm worker pools are reclaimed, not kept forever: a pool is live dbt processes
  holding a DuckDB file and, for a lake project, a Postgres connection.
  `_reclaim_pools` sweeps on the way into `run()` - idle past
  `DBT_WARM_WORKER_IDLE_SECONDS` first, then least-recently-used past
  `DBT_WARM_WORKER_MAX_PROJECTS`, and never a pool with a job in flight. When
  every other pool is busy it goes over the limit rather than refusing the
  command.
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

### Ingest
```bash
# Run one job the way the router does - config on stdin, never argv
echo "$JOB_JSON" | uv run python -m ingest.runner
uv run pytest tests/test_ingest_lakehouse.py -q   # end-to-end, no services needed
```

### Demo source (trying out ingest)
```bash
# Dummy CRM Postgres: customers/products/orders + a read-only role.
docker compose --profile demo up -d demo-source
# Connection details: host demo-source, port 5432, db crm,
# user ingest_reader, password demo_reader_pw. Needs
# INGEST_ALLOW_PRIVATE_HOSTS=true (a container address is private).
docker compose --profile demo down -v   # remove it again
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
  project. A warm worker also locks out the project's *own* next run, which is
  why `_regenerate_profiles_from_db` calls `warm_worker_pool.release_project()`
  before dbt starts on a file-backed DuckDB warehouse - without it the first run
  succeeds and every later one fails on the lock.
- The file listing endpoint returns one directory level (`{path, items[]}`), not
  a recursive tree — walk down a level at a time.
- `dbt source freshness` is two CLI words but one `run_command` enum value
  (`source_freshness`). `_insert_run_start` maps `source` → `source_freshness`;
  the UI maps it back. Miss either half and freshness runs are recorded, or
  displayed, as plain `run`.
- SQL formatting is `sqlglot`, not sqlfluff: `app/services/sql_format.py` masks
  Jinja, formats, and **refuses** rather than guesses when the round trip cannot
  be verified. The editor falls back to its local regex formatter in that case.
  sqlfluff with the dbt templater needs a compiled project per lint.
- `/dbt/compile` takes `model_path`, not `file_path`.
- **DuckLake metadata schema must be pinned on both sides.** dlt derives it from
  the DuckLake name while dbt-duckdb attaches into `public`, so the defaults build
  two independent catalogs over one data directory: ingest reports success and dbt
  then fails with `schema ... does not exist`. Everything goes through
  `lakehouse.metadata_schema()`.
- **DuckLake v1.0 inlines small writes into the catalog database**, not Parquet, so
  ingested rows silently end up inside Postgres - which also blocks the
  metadata-only migration to Iceberg. `lakehouse.provision()` pins
  `data_inlining_row_limit` (`LAKE_INLINE_ROW_LIMIT`, default 0). Existing inlined
  data is flushed with `CALL ducklake_flush_inlined_data('lake')`.
- DuckLake snapshots and dbt's `__dbt_backup` tables accumulate. The scheduler
  now does this (`lakehouse.maintain`, `LAKE_SNAPSHOT_RETENTION_DAYS`); each step
  is attempted independently because which `ducklake_*` functions exist depends
  on the extension version baked into the image.
- `INSTALL ducklake` reaches the internet, so the extensions are baked into the
  image. An air-gapped deployment that skips that build step fails on its first load.
- `dlt`'s incremental cursors live in `STORAGE_DIR/dlt/{project_id}`. Anywhere else
  and a container restart resets them, so the next load re-reads or skips rows.
- `INGEST_ALLOW_PRIVATE_HOSTS=true` is needed for on-premise warehouses. It does
  **not** unblock this deployment's own Postgres/Redis or link-local addresses -
  see `app/core/host_guard.py`, which compares resolved IPs, not hostnames.
- Models materialise into the lake only when they target it: `+database: lake`
  in `dbt_project.yml` (or per-model `config(database='lake')`). Without it dbt
  writes to the local `.duckdb` file while reading the lake, which looks like
  the marts silently went missing.
- **Only dbt-duckdb can attach a DuckLake catalog.** A project whose warehouse is
  Postgres/Dremio/Oracle loads into the lake successfully and then cannot read it
  from dbt. Those projects want the `connection` destination; the lake stays
  readable by engines outside dbt.
- **A dbt-built lake table has no partition spec.** `partition_by` on an ingest
  source only covers tables the ingest runner writes; dbt creates its own, so
  nothing here chooses their layout - which makes marts, the most queried tables
  in the lake, the likeliest to be scanned whole. Maintenance reports them
  (`lakehouse.unpartitioned_tables`) rather than guessing a column: the fix is a
  `post_hook` running `ALTER TABLE {{ this }} SET PARTITIONED BY (month(ts))`,
  and only the model's author knows which column its filters use.
- **An unpartitioned lake table is read in full.** A filter on a date scans every
  Parquet file unless the ingest source sets `partition_by`. At a few hundred GB
  that is the whole difference between seconds and minutes, and no engine choice
  recovers it.
- Appending loads leave many small Parquet files and a scan pays per file, so
  `lakehouse.maintain` merges them (`merge_adjacent_files`) *before* expiring
  snapshots - merging is what makes the old files unreferenced. The other order
  keeps the small ones another retention window.
- **The DuckLake catalog defaults to the application database.** It holds a row
  per Parquet file per snapshot, so past a few hundred GB of lake data it is a
  hot table competing with every application query. `LAKE_CATALOG_URL` moves it
  to its own Postgres; the default stays for existing deployments, and startup
  logs a warning when it is in use.
- A `duckdb` **file** connection is a development target. DuckDB is single-writer
  and a warm worker holds the file, so one file serves one project and nothing
  else can read it while dbt runs. A warehouse-sized deployment wants the
  DuckLake destination, which many readers can attach at once.
- The lake attach block is added to profiles.yml **only while the project has an
  ingest source with `destination = 'ducklake'`**. Delete the last one and models
  referencing `lake.*` stop resolving - the attach is gated in
  `DbtService._apply_lakehouse_attach` so projects that never ingest do not pay
  for a Postgres connection on every dbt invocation.

- **dsh-agent: the first prompt must wait for the MCP tools.** The harness
  answers `initialize` as soon as its JSON-RPC plugin activates, before its MCP
  client has discovered anything, and a turn assembled in that window is offered
  no dbt tools with nothing logged. The shim writes a readiness file when it
  serves `tools/list`; `HarnessSession.start()` waits for it. Related: the
  harness's stderr must be drained in chunks, because the MCP child inherits it
  and an unread pipe blocks that child - which looks exactly like the race.
- **dsh-agent drops empty environment values before spawning the harness.**
  Compose writes `""` for optional variables and the DeepSeek adapter took an
  empty `DEEPSEEK_BASE_URL` at face value, failing every request with
  `request to  failed`.
- **dsh-agent: stdout is the JSON-RPC protocol.** A composition row that logs to
  stdout makes every frame unparseable. Diagnostics go to stderr.
- **dsh-agent's image must run install scripts.** npm defers them by default in
  recent versions, which leaves `koffi` without its native module and the harness
  then fails to load `subprocess-local` and `sandbox-local`. koffi ships source
  only, so the Dockerfile compiles it in a builder stage. A composition can also
  answer `initialize` and exit 0 on an immediate `shutdown` while entries behind
  it failed - which is why startup boots the profile and waits before reporting
  healthy, and why a health check must not just initialize and shut down.
- `@deepseek-ai/dsh` is a **developer preview**: pin the version, and run
  `dsh-agent/plugins/dsh-session-resume/test_resume.py` after every upgrade. The
  whole integration rests on `ctx.agents.create/resume`,
  `ctx.sessionPersistence.list()` and a three-method JSON-RPC wire.
- `dsh plugin --profile <name> add` needs `-w`: `dsh` writes a
  `pnpm-workspace.yaml` into the profile directory, making it a workspace root
  that pnpm refuses to add to implicitly.

## What NOT to do

- Don't hardcode secrets — use `.env`, never committed.
- Don't add database RLS policies — auth/ownership is enforced in application code.
- Don't add third-party analytics or telemetry. This is self-hosted software.
- Don't add a warehouse to the connection UI without adding its dbt adapter to
  `dbt-runner/pyproject.toml`.
- Don't accept Python source for an ingest source. dlt defines sources in Python,
  which is remote code execution the moment that code comes from a request body.
  Source configuration is declarative (table lists) only.
- Don't skip `app/core/host_guard.py` on any endpoint that connects to a
  user-supplied host. Without it a user can point a connection at the application
  database and read every other user's encrypted credentials.
- Don't give dsh-agent database access or let it run dbt from its own shell. Both
  exist as one call into dbt-runner, which already enforces ownership, the run
  lock and the run semaphore.
