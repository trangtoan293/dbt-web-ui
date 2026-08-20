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


    # Concurrency limits
    max_concurrent_commands_per_project: int = 1
    max_concurrent_dbt_runs: int = 10  # global limit across all projects
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
