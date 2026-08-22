"""
Application configuration using Pydantic Settings.
"""

import os
from pathlib import Path
from typing import List

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Workspace configuration
    workspace_dir: str = "/tmp/dbt-projects"

    # Git
    git_clone_depth: int = 0

    # Server configuration
    host: str = "0.0.0.0"
    port: int = 8080

    # Logging
    log_level: str = "INFO"

    # CORS
    cors_origins: List[str] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]
    cors_allow_credentials: bool = True
    cors_allow_methods: List[str] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    cors_allow_headers: List[str] = [
        "Accept",
        "Authorization",
        "Content-Type",
        "X-Requested-With",
        "X-Session-ID",
    ]

    # Redis configuration
    redis_url: str = "redis://localhost:6379/0"
    session_lock_ttl: int = 3600  # 1 hour - session lock expiry
    file_lock_ttl: int = (
        60  # 1 minute - file operation lock expiry (shorter for faster cleanup)
    )
    file_lock_wait_timeout: int = 30  # 30 seconds - max wait for file lock (fail fast)

    # Database configuration
    database_url: str = os.getenv("DATABASE_URL", "")

    # OIDC configuration. Any spec-compliant provider works (Keycloak,
    # Authentik, Zitadel, Auth0, Entra, Google). jwks_uri is discovered from
    # {issuer}/.well-known/openid-configuration unless set explicitly.
    oidc_issuer: str = os.getenv("OIDC_ISSUER", "")
    oidc_jwks_uri: str = os.getenv("OIDC_JWKS_URI", "")
    oidc_audience: str = os.getenv("OIDC_AUDIENCE", "dbt-craft")

    # Single-user no-auth mode (LOCAL/self-host only). When true, JWT verification
    # is skipped and every request resolves to a fixed local user.
    # ponytail: trust-everyone toggle — only safe bound to localhost/trusted net.
    auth_disabled: bool = os.getenv("AUTH_DISABLED", "false").lower() == "true"

    # Storage configuration (local filesystem)
    storage_dir: str = os.getenv("STORAGE_DIR", "/data/storage")

    # Application encryption key
    app_encryption_key: str = os.getenv("APP_ENCRYPTION_KEY", "")

    # === Ingest / DuckLake lakehouse ===
    # Catalog lives in the application Postgres under a per-project metadata
    # schema; data files land on the shared storage volume. Point
    # LAKE_CATALOG_URL elsewhere to keep the catalog out of the app database.
    # Empty means "use DATABASE_URL". The fallback lives in
    # ingest/lakehouse._configured_catalog_url(), not in this default:
    # docker-compose passes LAKE_CATALOG_URL as an empty string when unset, and
    # pydantic-settings honours that, overwriting anything computed here.
    lake_catalog_url: str = os.getenv("LAKE_CATALOG_URL", "")
    lake_data_dir: str = os.getenv("LAKE_DATA_DIR", "")
    # DuckLake v1.0 stores small writes inside the catalog database instead of
    # Parquet. Left on, the app Postgres grows with ingested data, backups split
    # across two systems, and the metadata-only migration path to Iceberg is
    # unavailable. 0 = always write Parquet.
    lake_inline_row_limit: int = int(os.getenv("LAKE_INLINE_ROW_LIMIT", "0"))
    # Iceberg publish target. The catalog defaults to wherever the DuckLake
    # catalog lives, so the lakehouse keeps one metadata store. The warehouse is
    # deliberately *not* under LAKE_DATA_DIR: the lake's orphan cleanup scans that
    # tree and would find these published copies unreferenced.
    iceberg_catalog_url: str = os.getenv("ICEBERG_CATALOG_URL", "")
    iceberg_warehouse_dir: str = os.getenv("ICEBERG_WAREHOUSE_DIR", "")

    # Private/RFC1918 targets are refused by default. On-prem deployments whose
    # warehouses live on the LAN must opt in; own-infrastructure and link-local
    # targets stay blocked either way (see app/core/host_guard.py).
    ingest_allow_private_hosts: bool = (
        os.getenv("INGEST_ALLOW_PRIVATE_HOSTS", "false").lower() == "true"
    )
    ingest_subprocess_timeout: int = int(os.getenv("INGEST_SUBPROCESS_TIMEOUT", "3600"))
    # Log tail persisted per ingest run. Ingest logs are unbounded (dlt is
    # chatty and a load can run for an hour), and the whole point of the cap is
    # to keep this table from becoming the reason Postgres grows.
    ingest_run_log_max_chars: int = int(
        os.getenv("INGEST_RUN_LOG_MAX_CHARS", str(256 * 1024))
    )

    # === Scheduler (cron for dbt runs, retention, lake maintenance) ===
    # One runner process at a time holds the leader lock, so this is safe with
    # several uvicorn workers or several replicas against one Redis.
    scheduler_enabled: bool = os.getenv("SCHEDULER_ENABLED", "true").lower() == "true"
    scheduler_tick_seconds: int = int(os.getenv("SCHEDULER_TICK_SECONDS", "30"))
    scheduler_leader_ttl: int = int(os.getenv("SCHEDULER_LEADER_TTL", "90"))
    # A schedule whose due time is older than this is skipped rather than run:
    # after a long outage nobody wants yesterday's backlog firing at once.
    scheduler_misfire_grace_seconds: int = int(
        os.getenv("SCHEDULER_MISFIRE_GRACE_SECONDS", "3600")
    )
    # Delivery timeout for a failure webhook. Short: a wedged endpoint must not
    # hold up the next tick.
    webhook_timeout_seconds: int = int(os.getenv("WEBHOOK_TIMEOUT_SECONDS", "10"))

    # === Maintenance (runs from the scheduler, leader only) ===
    # dbt_runs rows carry the full log text, so history is the fastest growing
    # table in the deployment. 0 disables pruning and keeps everything.
    run_history_retention_days: int = int(os.getenv("RUN_HISTORY_RETENTION_DAYS", "90"))
    maintenance_interval_hours: int = int(os.getenv("MAINTENANCE_INTERVAL_HOURS", "24"))
    # DuckLake keeps every snapshot and dbt leaves __dbt_backup tables behind, so
    # without expiry the storage volume only grows. 0 disables lake maintenance.
    lake_snapshot_retention_days: int = int(
        os.getenv("LAKE_SNAPSHOT_RETENTION_DAYS", "7")
    )


    # === DuckDB engine resources ===
    # DuckDB is the query engine (dbt-duckdb, and the DuckLake lakehouse reads
    # through it too). Each dbt run is a separate process with its own DuckDB
    # instance, so these bound one run, not the deployment. See
    # app/core/duckdb_resources.py for why an unset limit is not a safe default.
    #
    # Empty = derive a per-run share of this container's memory. Set an explicit
    # value ("24GB") to override.
    duckdb_memory_limit: str = os.getenv("DUCKDB_MEMORY_LIMIT", "")
    # 0 = DuckDB uses every core. The `threads` key in profiles.yml is dbt's model
    # concurrency and multiplies with this, so cap it when several runs share a box.
    duckdb_threads: int = int(os.getenv("DUCKDB_THREADS", "0"))
    # Spill directory. DuckDB defaults to `<db file>.tmp`, i.e. inside the dbt
    # project volume, which is not the volume sized for data: one large aggregate
    # fills it and the run dies on "No space left on device". Empty =
    # STORAGE_DIR/duckdb-tmp.
    duckdb_temp_dir: str = os.getenv("DUCKDB_TEMP_DIR", "")
    # Cap on spill ("200GB"). Empty leaves DuckDB's own default (90% of free disk).
    duckdb_max_temp_size: str = os.getenv("DUCKDB_MAX_TEMP_DIRECTORY_SIZE", "")
    # "false" lets DuckDB drop row order on large scans and writes, which cuts peak
    # memory substantially at TB scale. Empty leaves DuckDB's own default (true),
    # because switching it on behalf of a project reorders its model output.
    #
    # A str, not a bool: docker-compose passes this as an empty string when unset
    # and pydantic-settings refuses to parse "" as a boolean, which would stop the
    # container from starting at all. Interpreted in
    # app/core/duckdb_resources.profile_settings().
    duckdb_preserve_insertion_order: str = os.getenv(
        "DUCKDB_PRESERVE_INSERTION_ORDER", ""
    )

    # Concurrency limits
    max_concurrent_commands_per_project: int = 1
    # Global limit across all projects. Each concurrent run is a DuckDB process
    # holding its own memory_limit share, so raising this shrinks every run's
    # memory. Three heavy runs already saturate a single node's disk bandwidth.
    max_concurrent_dbt_runs: int = int(os.getenv("MAX_CONCURRENT_DBT_RUNS", "3"))
    dbt_warm_worker_count: int = int(os.getenv("DBT_WARM_WORKER_COUNT", "1"))
    dbt_warm_worker_queue_size: int = int(os.getenv("DBT_WARM_WORKER_QUEUE_SIZE", "100"))
    dbt_warm_worker_timeout: int = int(os.getenv("DBT_WARM_WORKER_TIMEOUT", "120"))
    dbt_warm_worker_recycle_jobs: int = int(os.getenv("DBT_WARM_WORKER_RECYCLE_JOBS", "100"))
    dbt_warm_worker_enabled: bool = os.getenv("DBT_WARM_WORKER_ENABLED", "true").lower() == "true"
    # Hard ceiling on a single dbt subprocess so a hang can't hold the project lock forever.
    dbt_subprocess_timeout: int = int(os.getenv("DBT_SUBPROCESS_TIMEOUT", "1800"))

    # Browser error ingest (/client-logs): body size cap for untrusted input.
    client_logs_max_bytes: int = int(os.getenv("CLIENT_LOGS_MAX_BYTES", str(64 * 1024)))

    # Per-line buffer for the warm-worker IPC StreamReader. Must hold a full
    # `dbt show --output json` response line. Default 64 MiB (asyncio default is 64 KiB).
    dbt_warm_worker_stream_limit: int = int(os.getenv("DBT_WARM_WORKER_STREAM_LIMIT", str(64 * 1024 * 1024)))
    dbt_inline_query_timeout: int = int(os.getenv("DBT_INLINE_QUERY_TIMEOUT", "60"))

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


# Singleton settings instance
settings = Settings()

try:
    Path(settings.workspace_dir).mkdir(parents=True, exist_ok=True)
except (PermissionError, OSError):
    pass
