# Ingest + lakehouse — build journal

Chronological record of how the ingest feature was researched, designed and
built, including the decisions that were reversed and why. Operational detail
lives in [_hand-off.md](./_hand-off.md).

---

## 1. Picking the tool

**Requirement:** connect to multiple source systems and ingest from them,
light enough to deploy for small and mid-sized businesses.

Evaluated:

| Tool | Verdict |
|---|---|
| **dlt** | **Chosen.** A library, not a platform - runs in-process, no extra container, Apache-2.0. `sql_database` source reuses SQLAlchemy, already a dependency. |
| Airbyte / abctl | Rejected. One Docker image per connector, ~4GB RAM floor, plus temporal and workers. Platform is ELv2, which is a grey area when reselling as a service. |
| PyAirbyte | Rejected. Still spawns a container or venv per source; pays the operational cost without Airbyte's UI. |
| Meltano | Rejected. Needs a meltano project, `meltano.yml`, and a venv per tap - a second CLI layer next to dbt, over a Singer tap ecosystem of uneven quality. |
| Sling / ingestr | Kept as a fallback. Genuinely small, best-in-class DB→DB, but almost no SaaS API connectors. Faster than dlt for very large replications. |

## 2. Semantics, corrected by the user

First design put ingest as a tab inside `/connections`. Wrong: **Connections
are the source systems, Sources are the ingest jobs** - two different concepts,
so they get two places in the UI.

That correction simplified the schema: an `IngestSource` references an existing
`connections` row instead of storing its own credentials, so a warehouse
password still lives in exactly one table.

## 3. Destination: three attempts

**Attempt 1 - Iceberg with a SQLite catalog.** dlt has a first-class Iceberg
destination via `pyiceberg.load_catalog`. Design was written, then abandoned.

**The user pushed back:** "newer DuckDB can already write Iceberg." Correct, and
the first write-up was too broad. Verified against the docs:

- DuckDB writes Iceberg from v1.4.0; UPDATE/DELETE from 1.4.2; MERGE INTO and
  ALTER from 1.5.3.
- **But every write must go through an attached Iceberg REST catalog.** The
  path-based `iceberg_scan` interface stays read-only.
- Lakekeeper is the lightest REST catalog (Rust, Apache-2.0, Postgres backend)
  but **does not support a local filesystem** - only S3/ADLS/GCS. On-premise
  therefore means Lakekeeper *and* MinIO: two extra containers.

So attempt 1 had the cost of Iceberg with none of the write capability. Dropped.

**Attempt 2 - Iceberg with a REST catalog.** Full read/write lakehouse, but
+2 containers (~400MB RAM) for something an SMB running DuckDB will not use.
Kept as a documented upgrade path, not the default.

**Attempt 3 - DuckLake. Chosen.**

- Catalog in the Postgres the deployment already runs; Parquet on the existing
  `storage-data` volume. **Zero extra containers.**
- dlt has a native `ducklake` destination with better merge support than its
  Iceberg one (`delete-insert`, `upsert`, `scd2`, `insert-only` vs `upsert` and
  `insert-only`).
- Data files and positional deletes are Iceberg-compatible, so moving to
  Iceberg later is a metadata-only migration - no lock-in.
- Incremental dependency cost measured: **+21.4 MB, 19 packages**. `duckdb`,
  `pyarrow`, `sqlglot` and `sqlalchemy` were already in the image.

## 4. Proof before building

Everything below was run, not assumed:

| Check | Result |
|---|---|
| DuckDB 1.5.5 ATTACH ducklake, `CREATE OR REPLACE TABLE`, INSERT/UPDATE/DELETE | pass |
| Catalog on Postgres 16, data path local | pass |
| Two independent DuckDB connections writing the same dataset | pass, no lock error |
| dbt-duckdb 1.10.0 materialising `table` and `incremental` into DuckLake | pass |
| `dbt run` twice, idempotent | pass |
| dlt 1.30.0 `ducklake` destination, `sql_database` source | pass |
| End-to-end: dlt ingest → dbt reads → marts back into the lake | pass |

The concurrency result matters beyond ingest: the DuckDB single-writer wall
documented in CLAUDE.md does not apply to lake data.

## 5. Two traps found during the proof

Both would have shipped silently.

**Trap 1 - dlt and dbt build two different catalogs in one database.** dlt
derives its metadata schema from the DuckLake name (Postgres schema `lake`),
dbt-duckdb attaches into `public`. Same data directory, two independent
catalogs: ingest reports success, then dbt fails with `schema ... does not
exist`. Every attach now goes through `lakehouse.metadata_schema()`.

**Trap 2 - DuckLake v1.0 inlines small writes into the catalog database.** After
the whole proof, `find -name '*.parquet'` returned **zero files**; the data was
in 13 `ducklake_inlined_data_*` tables inside Postgres. Queries were correct, so
it was completely silent. Consequences: Postgres grows with ingested data,
backups split across two systems, and the metadata-only path to Iceberg is
unavailable. Fixed by pinning `data_inlining_row_limit` in
`lakehouse.provision()`; the regression test fails if inlining is re-enabled.

## 6. Bugs found in my own code

| Bug | How it would have failed |
|---|---|
| Host guard compared **hostnames**, not resolved IPs | With `INGEST_ALLOW_PRIVATE_HOSTS=true` - the setting every on-premise deployment needs - typing the app database's LAN IP instead of its service name bypassed the guard entirely. |
| `session.rollback()` on a missing `ingest_sources` table | The same session may already have UPDATEd `users.oidc_sub` in `resolve_user_id`; the rollback discarded it. Replaced with a `to_regclass()` probe. |
| `provision()` read global settings while the job config already named a catalog | Untestable without Postgres, and could provision a different catalog than the one being written. Now takes explicit arguments. |
| `LAKE_CATALOG_URL` fallback computed in the Settings default | docker-compose passes the variable as an empty string; pydantic-settings honours that, so the `DATABASE_URL` fallback never applied and the lakehouse reported itself unconfigured in **every** default deployment. Fallback moved to call time. |
| `apiFetch<any[]>` | Passed `next lint` on a single file but failed `npm run build`, whose lint is stricter. |

## 7. Pre-existing bugs surfaced by the feature

None of these were introduced here; the new UI was just the first caller.

- **`PostgreSQLAdapter._get_views`**: `WHERE table_schema = $1` with no argument
  passed. Present since the initial commit. Broke the table picker and would
  have broken `/connection/schema` for any Postgres connection. Fixed, plus a
  static AST test that scans every adapter for placeholder/argument mismatches.
- **`/connection/usage/{id}`**: only checked `dremio_source_id`, so every
  warehouse connection reported itself as unused. The endpoint had no frontend
  caller, which is why nobody noticed.
- **A warm worker locks the project out of its own next run.** A warm worker
  keeps a dbt process alive, which keeps the project's `.duckdb` file open;
  DuckDB is single-writer, so the *first* `dbt run` succeeds and every later one
  fails with `Could not set lock on file`. `_regenerate_profiles_from_db` now
  calls `warm_worker_pool.release_project()` - the one point every dbt
  invocation passes through.
- **Privilege escalation that predates ingest**: a user could point a
  PostgreSQL connection at the application's own database, attach it to a
  project, and read `connections.password_encrypted` for every other user
  through ordinary dbt queries. The guard was therefore put in
  `app/core/host_guard.py` and wired into `/connection/test`,
  `/connection/schema`, `/dremio/test` and the ingest paths, rather than only
  the new feature.

## 8. Claims that were wrong and got retracted

Recorded because they cost time and could mislead a reader of the diff.

- **"dbt can only read Iceberg, not write it."** Too broad. DuckDB writes
  Iceberg; the real constraint is that writes need an attached REST catalog.
- **"`yaml.safe_dump` folding at column 80 corrupts the DSN."** Investigated on
  the assumption a fold injects a space mid-connection-string. PyYAML only folds
  at existing spaces and the round-trip is lossless, so there was no bug. The
  "fix" and its test - which passed with or without the fix, therefore testing
  nothing - were both reverted.
- **`pytest.importorskip("duckdb")`** turned the only end-to-end test into a
  silent skip when the venv was pruned. `duckdb` and `dlt` are hard
  dependencies, so a missing one is a broken environment, not a reason to skip.
  Removed.

## 9. UI review (browser)

Reviewed the running app, not the source:

| Finding | Fix |
|---|---|
| `/sources` was full-width while every other page uses `mx-auto max-w-4xl` | matched |
| Connection dropdown silently empty when no readable connection exists | amber message naming the required types and where to create one |
| `Missing Description or aria-describedby for DialogContent` | added `DialogDescription` |
| Long dlt log lines clipped with no way to read them | `overflow-auto` |
| Nothing indicated a source row expands to reveal Run | chevron + `aria-expanded` |
| **Browse only existed in Edit mode** | endpoint re-keyed from source to connection, so the picker works before the source is ever saved |
| Deleting a source was one click, no confirmation | confirm dialog naming the consequences |
| Delete-connection warning was generic | now names the projects and ingest sources that depend on it, and refuses when a `RESTRICT` foreign key would reject the delete anyway |

Passwords were never typed into a browser form; test connections were seeded
through SQL using the application's own `encrypt_secret_v1`.

## 10. Final end-to-end run

On the real project, through the same endpoints the UI uses:

```
demo-source (Postgres, 10 customers / 6 products / 15 orders)
   │ dlt sql_database
   ▼
lake.raw_crm.{customers, products, orders}
   │ dbt-duckdb, +database: lake
   ▼
lake.staging.{stg_customers, stg_products, stg_orders}   (views)
   ▼
lake.marts.{dim_customer, dim_product, fct_orders}       (tables, fct incremental)
   ▼
SELECT ... GROUP BY → report
```

Three consecutive `dbt run` invocations return 0; row counts stay 10 / 6 / 15,
so nothing duplicates. `duckdb_tables()` confirms all nine tables live in the
`lake` catalog, backed by Parquet on the volume.

## 11. Architecture coverage

Against the target architecture:

| Layer | Status |
|---|---|
| Sources → DuckDB | done, verified |
| PostgreSQL as DuckLake metadata catalog | done, verified |
| dbt-duckdb → dim/fact **inside the lake** | done, verified |
| Parquet on **S3 / MinIO** | **not done** - `lakehouse.data_dir()` builds a local `Path` and `provision()` calls `mkdir` on it. dlt, DuckDB and dbt-duckdb all support object storage already; the wiring is missing. |
| Reporting via SQL | done |
| Metabase / Superset | **not verified.** Both need to run the DuckLake `ATTACH` at connect time. Materialising marts into Postgres is the route that needs no community driver. |
