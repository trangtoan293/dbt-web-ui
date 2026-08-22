# Ingest + lakehouse — hand-off

What exists, how to run it, what is deliberately missing. Design history is in
[_journal.md](./_journal.md); repo-wide conventions stay in
[CLAUDE.md](./CLAUDE.md).

**State:** deployed and working on this machine. 83 backend tests pass, no
TypeScript errors, ESLint clean. Nothing here is committed yet.

---

## 1. What the feature does

A **Source** reads tables from an existing **Connection** over SQL and loads
them into either the lakehouse or the project's own warehouse. dbt then
transforms them into dim/fact tables, and reports read those.

```
Connection (postgresql | oracle)
      │ dlt sql_database, in a subprocess
      ▼
DuckLake:  catalog in Postgres  +  Parquet on the storage volume
      │ dbt-duckdb, +database: lake
      ▼
staging views → marts (dim_*, fct_*)
      ▼
SQL / BI
```

Source rows store **no credentials** - they reference a `connections` row, so a
warehouse password still lives in exactly one table.

## 2. File map

### Backend (`dbt-runner/`)

| Path | Lines | Role |
|---|---|---|
| `ingest/__init__.py` | 29 | registry and module contract |
| `ingest/lakehouse.py` | 182 | DuckLake layout: metadata schema, data dir, attach string, `provision()`. Shared with dbt profile generation. |
| `ingest/sql_source.py` | 59 | `connections` row → SQLAlchemy URL |
| `ingest/destination.py` | 82 | `ducklake` or `connection` → dlt destination config |
| `ingest/runner.py` | 161 | `python -m ingest.runner`, one job per subprocess, config on **stdin** |
| `app/core/host_guard.py` | 146 | refuses hosts that reach our own infrastructure; compares resolved IPs |
| `app/routers/ingest.py` | 528 | the five endpoints below |
| `app/models/ingest.py` | 34 | pydantic request/response |

Touched: `app/config.py` (settings), `app/core/auth.py`
(`verify_project_ownership`, consolidated from four identical copies),
`app/routers/connection.py` (guard + fixed usage query), `app/routers/{dbt,files,git,sse}.py`
(use the shared ownership helper), `app/services/dbt_service.py`
(`_apply_lakehouse_attach`, warm-worker release), `app/services/dbt_worker.py`
(`release_project`), `adapters/duckdb.py` (renders `attach:` and `database:`),
`adapters/postgresql.py` (bind-argument fix), `Dockerfile`, `pyproject.toml`.

### Frontend (`nextjs/`)

`src/app/(app)/sources/page.tsx`, `src/components-v2/sources/{SourceDialog,IngestRunPanel}.tsx`,
`src/lib/hooks/useIngestStream.ts`, `src/app/api/ingest/route.ts` (831 lines total),
plus additions to `src/lib/api-client.ts`, `src/lib/actions/data.ts`,
`src/components-v2/layout/{navigation.ts,Sidebar.tsx}`, and the delete-warning
work in `src/app/(app)/connections/page.tsx`.

### Schema

`prisma/schema.prisma`: `IngestSource` + two enums, 46 added lines, no deletions.
Migration `20260821120000_add_ingest_sources` — **hand-written**, because
`prisma migrate diff` also picked up unrelated drift from the dev database
including a `DROP TABLE`.

## 3. Endpoints

```
GET  /ingest/meta                                  what this deployment can read/write
GET  /ingest/connections/{connection_id}/tables    table picker
GET  /ingest/sources/{source_id}/dbt-sources       ready-to-paste sources.yml
POST /ingest/sources/{source_id}/cancel            kill a running load
POST /sse/ingest/{source_id}                       run one load, streamed
```

CRUD for sources is Prisma-side at `/api/ingest` (same pattern as
`/api/connections`); dbt-runner only reads the rows.

## 4. Configuration

All on `dbt-runner`, via the `x-ingest-env` anchor in `docker-compose.yml`:

| Variable | Default | Notes |
|---|---|---|
| `LAKE_CATALOG_URL` | empty → `DATABASE_URL` | Point elsewhere to keep the catalog out of the app database. `postgresql://` or `sqlite:///`. |
| `LAKE_DATA_DIR` | `/data/storage/lake` | Local path only today (see §7). |
| `LAKE_INLINE_ROW_LIMIT` | `0` | **Leave at 0.** Above 0, DuckLake stores rows inside the catalog database instead of Parquet. |
| `INGEST_ALLOW_PRIVATE_HOSTS` | `false` | Must be `true` for LAN warehouses and for `demo-source`. Never unblocks our own Postgres/Redis or link-local. |
| `INGEST_SUBPROCESS_TIMEOUT` | `3600` | Hard ceiling per load. |

`.env` on this machine already has `INGEST_ALLOW_PRIVATE_HOSTS=true`.

## 5. Running it

```bash
docker compose build dbt-runner frontend db-migrate
docker compose run --rm db-migrate npx prisma migrate deploy
docker compose up -d
```

Backend tests:
```bash
cd dbt-runner && PYTHONPATH=. uv run pytest -q     # 83 pass
```

`PYTHONPATH=.` is required — several pre-existing test modules import `app`
without adjusting `sys.path`.

Frontend tests need a dedicated database:
```bash
# nextjs/.env.test (already created here, gitignored via .env*)
DATABASE_URL=postgresql://<user>:<pw>@127.0.0.1:5434/dbtcraft_test
cd nextjs && npm run test
```

### Demo source

```bash
docker compose --profile demo up -d demo-source     # not started by a plain `up -d`
```

Seed lives in `demo/postgres-seed.sql`: `customers` (10), `products` (6),
`orders` (15), each with `updated_at`, plus a **read-only** `ingest_reader`
role — worth copying in production, ingest only ever needs SELECT.

Connection details for the UI:

```
Type postgresql · Host demo-source · Port 5432 · Database crm
User ingest_reader · Password demo_reader_pw · Schema public
```

Remove with `docker compose --profile demo down -v`.

## 6. Using it

1. **Connections** → create a PostgreSQL or Oracle connection. Only those two
   have a synchronous SQLAlchemy driver in the image, so only those appear as
   ingest sources.
2. **Sources → New source** → project, connection, name, dataset (target
   schema, `^[a-z][a-z0-9_]{0,39}$`), tables (**Browse** lists them), destination,
   write disposition.
3. Click the source row (chevron) → **Run ingest**. Logs stream; the result
   shows row counts per table.
4. **Show dbt sources.yml** → paste into the project.
5. For marts in the lake, `dbt_project.yml` needs `+database: lake`:

```yaml
models:
  <project>:
    +database: lake          # without this, dbt reads the lake and writes locally
    staging:
      +schema: staging
      +materialized: view
    marts:
      +schema: marts
      +materialized: table
```

A `generate_schema_name` macro keeps schemas as `staging`/`marts` instead of
dbt's default `main_staging`/`main_marts`. Project `toant` has a full worked
example: source `CRM sync`, three staging views, `dim_customer`, `dim_product`,
`fct_orders`.

## 7. Not done

| Gap | What it takes |
|---|---|
| **Parquet on S3 / MinIO** | `lakehouse.data_dir()` returns a `Path` (which collapses `s3://` to `s3:/`) and `provision()` calls `mkdir` on it, so an object-store URL breaks. Needs: string paths with an object-store prefix, `LAKE_S3_*` settings, `INSTALL httpfs` + `CREATE SECRET` in `provision()`, a `secrets:` block in the generated profile (dbt-duckdb supports it), storage credentials passed to dlt, and MinIO under the `demo` profile to test. ~250 lines. |
| **Metabase / Superset verified** | Both must run the DuckLake `ATTACH` at connect time. Untested. Materialising marts into Postgres is the route that needs no community driver. |
| ~~Lake maintenance~~ | **Done.** `lakehouse.maintain()` drops `__dbt_backup` tables, expires snapshots and deletes orphaned files; the scheduler runs it every `MAINTENANCE_INTERVAL_HOURS` with `LAKE_SNAPSHOT_RETENTION_DAYS`. |
| ~~Run history~~ | **Done.** `ingest_runs` + `GET /ingest/sources/{id}/runs` and `/ingest/runs/{id}/logs`; the History button in the source panel reads them. Logs are a capped tail (`INGEST_RUN_LOG_MAX_CHARS`). |
| Ingest scheduling | Still none — `dbt_schedules` covers dbt commands only. External cron against `POST /sse/ingest/{id}`, or add an `ingest` command kind to the scheduler. |
| `rest_api` source | Not wired. dlt's declarative REST config would fit the existing shape. |
| Custom SQL per source | Table selection only, on purpose. |

## 8. Gotchas that will bite

1. **`+database: lake` is mandatory for marts.** Without it dbt reads the lake
   and writes to the local `.duckdb` file — it looks like the marts vanished.
2. **Only dbt-duckdb can attach a DuckLake catalog.** A project whose warehouse
   is Postgres/Dremio/Oracle loads into the lake fine and then cannot read it
   from dbt. `GET /ingest/sources/{id}/dbt-sources` prints a warning in that
   case. Those projects want the `connection` destination.
3. **The attach block exists only while the project has a `ducklake` source.**
   Delete the last one and models referencing `lake.*` stop resolving. The gate
   is deliberate: projects that never ingest should not pay for a Postgres
   connection on every dbt invocation.
4. **Never raise `LAKE_INLINE_ROW_LIMIT`** unless you want ingested rows inside
   Postgres. Existing inlined data flushes with
   `CALL ducklake_flush_inlined_data('lake')`.
5. **dlt's incremental cursors live in `STORAGE_DIR/dlt/{project_id}`.**
   Anywhere else and a container restart resets them, so the next load re-reads
   or skips rows.
6. **`INSTALL ducklake` reaches the internet**, so the extensions are baked into
   the image. An air-gapped build that skips that step fails on the first load.
7. **Merge on Iceberg** (if the REST-catalog path is ever taken) does not
   support schema evolution with pyiceberg 0.10.0: a new source column fails the
   load. Irrelevant for DuckLake.

## 9. Known-broken, unrelated to this work

- `nextjs/test/prisma-e2e.test.ts` — 7 failures. It exercises `DbtModel`,
  `TodoList`, `ChatConversation` and `ChatMessage`, all removed by the committed
  migration `20260820120000_trim_unused_features`. The test file was never
  updated. Present at `HEAD`, nothing to do with ingest; fix is deleting the
  stale cases.
- `dbt-runner/app/services/dbt_service.py` and several `nextjs/src` files carry
  uncommitted changes that predate this work (SQLAlchemy warehouse adapters
  removed, UI tweaks). Untouched here.

## 10. Leftovers on this machine

- `ducklake_poc` database in Postgres — throwaway from the feasibility spike.
  `docker compose exec postgres psql -U dbtcraft -d dbtcraft -c 'DROP DATABASE ducklake_poc'`
- `dbtcraft_test` database — created so the frontend suite can run. Keep it.
- Connections `demo CRM (postgres)` and `toant warehouse (duckdb)`, and the
  worked example in project `toant`. Delete freely; the `demo-source` container
  and its seed can be recreated any time.
