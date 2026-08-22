"""
dbt operations service.
Handles all dbt command executions.
"""

import asyncio
import importlib
import json
import logging
import re
import shlex
import socket
import sys
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.file_lock import AsyncFileLock
from app.core.global_semaphore import global_run_semaphore
from app.core.crypto import decrypt_secret_or_plaintext
from app.exceptions import DbtOperationError
from app.lineage import get_full_lineage
from app.models.dbt import (
    CompileRequest,
    DbtCommand,
    DbtInitRequest,
    ExplainRequest,
    LineageRequest,
    PreviewRequest,
    QueryRequest,
)
from app.models.docs import DocsGenerateRequest, DocsServeRequest
from app.services.command import CommandService
from app.services.dbt_worker import DbtWarmWorkerError, DbtWarmWorkerPool, warm_worker_pool
from app.services.project import ProjectService
from app.core import duckdb_resources
from ingest import lakehouse

logger = logging.getLogger(__name__)

ALLOWED_ENV_VAR_NAME_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")
DBT_PROFILE_SECRET_ENV = "DBT_ENV_SECRET_DBT_CRAFT_CREDENTIAL"
DBT_PROFILE_SECRET_PLACEHOLDER = "{{ env_var('DBT_ENV_SECRET_DBT_CRAFT_CREDENTIAL') }}"

# The project's own connection is always this target, so a project that never
# defines another one renders exactly the profile it did before targets existed.
DEFAULT_TARGET_NAME = "dev"
# Target names become profiles.yml output keys, dbt --target values and env var
# suffixes, so the shape is checked once here rather than escaped three times.
TARGET_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,29}$")


def _load_adapters_module():
    """Load local connection adapters even when workers start with a narrow sys.path.

    A process can launch with a cwd/sys.path that omits the dbt-runner repo root,
    so a bare `from adapters import ...` would fail there.
    """
    try:
        return importlib.import_module("adapters")
    except ModuleNotFoundError as exc:
        if exc.name != "adapters":
            raise
        repo_root = Path(__file__).resolve().parents[2]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        return importlib.import_module("adapters")


def _load_connection_adapter_factory():
    return _load_adapters_module().get_adapter


def _duckdb_default_db_file() -> str:
    _load_adapters_module()  # fixes sys.path when needed
    return importlib.import_module("adapters.duckdb").DEFAULT_DB_FILE


def _fix_in_memory_duckdb_profile(project_path: Path) -> None:
    """Repoint an existing in-memory DuckDB profile at a project-local file.

    Projects created before this fix have `path: ':memory:'` on disk. Because
    every dbt command runs in its own process, such a profile drops every model
    at the end of the run, and the next run fails with
    "Catalog Error: Table with name <upstream model> does not exist".
    """
    profiles_file = project_path / "profiles.yml"
    try:
        content = profiles_file.read_text()
    except OSError:
        return
    if ":memory:" not in content:
        return
    profiles_file.write_text(content.replace(":memory:", _duckdb_default_db_file()))
    logger.info("Repointed in-memory DuckDB profile at %s", profiles_file)


SPARK_EXTRA_CONFIG_KEYS = {
    "method",
    "threads",
    "secret_type",
    "driver",
    "cluster",
    "endpoint",
    "auth",
    "kerberos_service_name",
    "organization",
    "connection_string_suffix",
    "connect_retries",
    "connect_timeout",
    "use_ssl",
    "server_side_parameters",
    "retry_all",
    "query_timeout",
    "poll_interval",
    "query_retries",
}


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def build_adapter_config_from_connection_row(
    conn_row: Dict[str, Any],
    secret_value: Optional[str] = DBT_PROFILE_SECRET_PLACEHOLDER,
) -> tuple[str, Dict[str, Any], bool]:
    """Map a connections table row to adapter config.

    Returns connection type, adapter config, and whether this profile needs the
    shared dbt secret env var.
    """
    conn_type = conn_row["connection_type"]
    extra_cfg: Dict[str, Any] = dict(conn_row.get("extra_config") or {})
    needs_secret = False

    if conn_type == "postgresql":
        needs_secret = True
        return conn_type, {
            "host": conn_row["host"],
            "port": conn_row["port"],
            "user": conn_row["username"],
            "password": secret_value,
            "dbname": conn_row["database"],
            "schema": extra_cfg.get("schema") or "public",
            "threads": 4,
        }, needs_secret

    if conn_type == "duckdb":
        return conn_type, {
            "path": conn_row["database"] or "",
            "schema": extra_cfg.get("schema") or "main",
            "threads": 4,
        }, needs_secret

    if conn_type == "oracle":
        username = conn_row["username"] or ""
        needs_secret = True
        return conn_type, {
            "host": conn_row["host"],
            "port": conn_row["port"],
            "user": username,
            "password": secret_value,
            "service": extra_cfg.get("service") or conn_row["database"],
            "schema": extra_cfg.get("schema") or username.upper(),
            "threads": 4,
        }, needs_secret

    if conn_type == "dremio":
        auth_type = extra_cfg.pop("auth_type", "pat")
        needs_secret = True
        adapter_config = {
            "host": conn_row["host"],
            "port": conn_row["port"],
            "user": conn_row["username"],
            "dremio_space": conn_row["database"] or f"@{conn_row['username']}",
            "threads": 4,
            **extra_cfg,
        }
        if auth_type == "password":
            adapter_config["password"] = secret_value
        else:
            adapter_config["pat"] = secret_value
        return conn_type, adapter_config, needs_secret

    if conn_type == "spark":
        secret_type = str(extra_cfg.get("secret_type") or "none").lower()
        adapter_config = {
            "host": conn_row["host"],
            "port": conn_row["port"],
            "schema": conn_row["database"],
            "user": conn_row["username"],
        }
        for key in SPARK_EXTRA_CONFIG_KEYS:
            if key in extra_cfg:
                adapter_config[key] = extra_cfg[key]
        if secret_type in {"password", "token"}:
            adapter_config["secret_type"] = secret_type
            adapter_config[secret_type] = secret_value
            needs_secret = True
        return conn_type, adapter_config, needs_secret

    # Adding a warehouse means: an adapter in adapters/__init__.py, its dbt
    # plugin in pyproject.toml, and the type in CONNECTION_TYPES on the
    # frontend. A mapping here alone only produces failed runs.
    raise ValueError(f"Unsupported connection_type: {conn_type}")


def build_adapter_config_from_dremio_source_row(
    src_row: Dict[str, Any],
    secret_value: Optional[str] = DBT_PROFILE_SECRET_PLACEHOLDER,
) -> tuple[str, Dict[str, Any], bool]:
    username = src_row["username"] or ""
    return "dremio", {
        "host": src_row["host"],
        "port": src_row["port"],
        "user": username,
        "pat": secret_value,
        "dremio_space": src_row["catalog"] or (f"@{username}" if username else "@dremio"),
        "threads": 4,
    }, True


def sanitize_dbt_environment(raw_env: Optional[Dict[str, str]]) -> Dict[str, str]:
    """Return validated dbt env vars from a client request."""
    if not raw_env:
        return {}

    sanitized: Dict[str, str] = {}
    for key, value in raw_env.items():
        name = (key or "").strip()
        if not name:
            continue
        if len(name) > 128 or (not name[0].isalpha() and name[0] != "_"):
            continue
        if any(char not in ALLOWED_ENV_VAR_NAME_CHARS for char in name):
            continue
        sanitized[name] = str(value)
    return sanitized


class DbtService:
    """Service for dbt operations."""

    def __init__(
        self,
        command_service: Optional[CommandService] = None,
        project_service: Optional[ProjectService] = None,
        worker_pool: Optional[DbtWarmWorkerPool] = None,
    ):
        self.command = command_service or CommandService()
        self.project = project_service or ProjectService()
        self.worker_pool = worker_pool or warm_worker_pool

        # Track running docs servers per project: {project_id: {process, port, url}}
        self._docs_servers: Dict[str, Dict[str, Any]] = {}

    @staticmethod
    def _invalidate_partial_parse_cache(project_path: Path) -> None:
        """Remove dbt's partial-parse cache after dependency changes."""
        partial_parse_path = project_path / "target" / "partial_parse.msgpack"
        try:
            partial_parse_path.unlink(missing_ok=True)
        except Exception as exc:
            logger.warning(
                "Could not remove partial parse cache at %s: %s",
                partial_parse_path,
                exc,
            )

    async def _run_dbt_command(
        self,
        cmd: List[str],
        project_path: Path,
        *,
        project_id: str,
        env: Optional[Dict[str, str]] = None,
        fallback_process_id: Optional[str] = None,
        cancellable: bool = False,
        timeout: Optional[float] = None,
        fallback_on_worker_timeout: bool = True,
        perf_label: str = "dbt",
    ) -> tuple[int, str, str]:
        """Run a dbt command through the warm worker, with subprocess fallback."""
        if not cmd or cmd[0] != "dbt":
            raise ValueError("_run_dbt_command expects a dbt command")

        start = time.perf_counter()
        try:
            returncode, stdout, stderr, queue_wait_ms = await self.worker_pool.run(
                cmd[1:],
                project_path,
                project_id=project_id,
                env=env,
            )
            logger.info(
                "[DBT-PERF] %s warm_worker queue_wait_ms=%s returncode=%s elapsed_ms=%s cmd=%s",
                perf_label,
                queue_wait_ms,
                returncode,
                _elapsed_ms(start),
                " ".join(cmd),
            )
            return returncode, stdout, stderr
        except (DbtWarmWorkerError, TimeoutError, asyncio.TimeoutError) as exc:
            if isinstance(exc, asyncio.TimeoutError) and not fallback_on_worker_timeout:
                timeout_seconds = timeout or settings.dbt_warm_worker_timeout
                logger.warning(
                    "Warm dbt worker timed out for %s; not falling back to subprocess",
                    " ".join(cmd),
                )
                return (
                    -1,
                    "",
                    f"dbt command timed out after {timeout_seconds:g} seconds",
                )
            logger.warning(
                "Warm dbt worker failed for %s; falling back to subprocess: %s",
                " ".join(cmd),
                exc,
            )
            if cancellable:
                return await self.command.run_cancellable(
                    cmd,
                    project_path,
                    fallback_process_id or str(project_path),
                    env=env,
                    timeout=timeout,
                )
            return await self.command.run(cmd, project_path, env=env)

    @staticmethod
    async def reconcile_stale_runs(session: AsyncSession) -> int:
        """Mark runs abandoned by a runner restart as cancelled."""
        result = await session.execute(
            text("""
                UPDATE dbt_runs SET
                    status = 'cancelled',
                    completed_at = NOW(),
                    duration_ms = CASE
                        WHEN started_at IS NULL THEN NULL
                        ELSE (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::bigint
                    END,
                    error_message = COALESCE(
                        error_message,
                        'Runner restarted before the command completed'
                    )
                WHERE status = 'running'
                RETURNING id
            """)
        )
        stale_runs = result.fetchall()
        await session.commit()
        return len(stale_runs)

    @staticmethod
    def target_secret_env(target: str) -> str:
        """Name of the env var carrying one target's credential.

        Every output needs its own: with two targets sharing
        DBT_ENV_SECRET_DBT_CRAFT_CREDENTIAL, whichever profile is rendered last
        wins and the other target authenticates against its warehouse with the
        wrong password. The default target keeps the original name, so a
        single-target project's profile is byte-identical to before.
        """
        if target == DEFAULT_TARGET_NAME:
            return DBT_PROFILE_SECRET_ENV
        suffix = "".join(char if char.isalnum() else "_" for char in target).upper()
        return f"{DBT_PROFILE_SECRET_ENV}__{suffix}"

    @staticmethod
    async def _load_project_targets(
        session: AsyncSession, project_id: str
    ) -> List[Dict[str, Any]]:
        """Extra named targets for this project, beyond the default one.

        Absent table means a deployment that has not applied the targets
        migration yet; asking to_regclass first keeps a dbt run working there
        instead of aborting the transaction on a missing relation.
        """
        exists = await session.execute(
            text("SELECT to_regclass('project_targets') IS NOT NULL")
        )
        if not exists.scalar():
            return []
        result = await session.execute(
            text(
                "SELECT name, connection_id FROM project_targets "
                "WHERE project_id = CAST(:pid AS uuid) ORDER BY name"
            ),
            {"pid": project_id},
        )
        return [
            {"name": row["name"], "connection_id": str(row["connection_id"])}
            for row in result.mappings().all()
            if TARGET_NAME_RE.match(str(row["name"] or ""))
        ]

    @staticmethod
    async def _build_target_config(
        session: AsyncSession,
        *,
        connection_id: Optional[str],
        dremio_source_id: Optional[str],
        secret_env: str,
    ) -> tuple[str, Dict[str, Any], Dict[str, str]]:
        """Adapter config for one profiles.yml output, plus the env it needs."""
        placeholder = f"{{{{ env_var('{secret_env}') }}}}"
        dbt_env: Dict[str, str] = {}

        if connection_id:
            result = await session.execute(
                text(
                    "SELECT connection_type, host, port, database, username, "
                    "password_encrypted, extra_config "
                    "FROM connections WHERE id = CAST(:cid AS uuid)"
                ),
                {"cid": str(connection_id)},
            )
            row = result.mappings().first()
            if not row:
                raise DbtOperationError(
                    "profile setup",
                    f"connection {connection_id} attached to this project no longer "
                    "exists - attach an existing connection in the UI",
                )
            conn_type, adapter_config, needs_secret = (
                build_adapter_config_from_connection_row(dict(row), placeholder)
            )
            secret_column = "password_encrypted"
        else:
            result = await session.execute(
                text(
                    "SELECT host, port, username, token_encrypted, catalog "
                    "FROM dremio_sources WHERE id = CAST(:sid AS uuid)"
                ),
                {"sid": str(dremio_source_id)},
            )
            row = result.mappings().first()
            if not row:
                raise DbtOperationError(
                    "profile setup",
                    f"Dremio source {dremio_source_id} attached to this project no "
                    "longer exists - attach an existing connection in the UI",
                )
            conn_type, adapter_config, needs_secret = (
                build_adapter_config_from_dremio_source_row(dict(row), placeholder)
            )
            secret_column = "token_encrypted"

        if needs_secret:
            secret = decrypt_secret_or_plaintext(row[secret_column])
            if secret:
                dbt_env[secret_env] = secret

        return conn_type, adapter_config, dbt_env

    @staticmethod
    async def _regenerate_profiles_from_db(
        session: AsyncSession, project_id: str, project_path: Path
    ) -> Dict[str, str]:
        """Regenerate profiles.yml from the project's stored connections.

        Queries dbt_projects → connection_id or dremio_source_id for the default
        `dev` target, then project_targets for any extra named target (staging,
        prod, ...). Each target is rendered by its own adapter and the outputs
        are merged into one profile, so `dbt run --target prod` reaches a
        different warehouse without a second project.

        Returns an empty env (and leaves profiles.yml alone) only when the
        project has no connection at all, i.e. the user manages profiles.yml by
        hand. When a connection *is* attached but its profile cannot be
        rendered, raises DbtOperationError instead of falling back to the file on
        disk: a stale or placeholder profile silently points dbt at the wrong
        warehouse.
        """
        import yaml as _yaml
        get_adapter = _load_connection_adapter_factory()

        try:
            result = await session.execute(
                text(
                    "SELECT connection_id, dremio_source_id "
                    "FROM dbt_projects "
                    "WHERE id = CAST(:pid AS uuid) AND deleted_at IS NULL"
                ),
                {"pid": project_id},
            )
            row = result.mappings().first()
            if not row:
                return {}

            connection_id = row["connection_id"]
            dremio_source_id = row["dremio_source_id"]
            extra_targets = await DbtService._load_project_targets(session, project_id)

            if not connection_id and not dremio_source_id and not extra_targets:
                # manual profiles.yml – leave it alone, except for the broken
                # in-memory DuckDB target older placeholders were written with.
                _fix_in_memory_duckdb_profile(project_path)
                return {}

            dbt_project_file = project_path / "dbt_project.yml"
            if not dbt_project_file.exists():
                return {}

            with open(dbt_project_file) as f:
                dbt_project = _yaml.safe_load(f)
            profile_name = dbt_project.get("profile") or dbt_project.get("name")
            if not profile_name:
                return {}

            specs: List[tuple[str, Optional[str], Optional[str]]] = []
            if connection_id or dremio_source_id:
                specs.append((DEFAULT_TARGET_NAME, connection_id, dremio_source_id))
            specs.extend(
                (target["name"], target["connection_id"], None)
                for target in extra_targets
                if target["name"] != DEFAULT_TARGET_NAME
            )

            dbt_env: Dict[str, str] = {}
            outputs: Dict[str, Any] = {}
            default_target: Optional[str] = None
            release_duckdb_file = False
            conn_types: List[str] = []

            for target_name, target_connection_id, target_dremio_id in specs:
                secret_env = DbtService.target_secret_env(target_name)
                conn_type, adapter_config, target_env = (
                    await DbtService._build_target_config(
                        session,
                        connection_id=target_connection_id,
                        dremio_source_id=target_dremio_id,
                        secret_env=secret_env,
                    )
                )
                dbt_env.update(target_env)
                dbt_env.update(
                    await DbtService._apply_lakehouse_attach(
                        session, project_id, conn_type, adapter_config
                    )
                )
                DbtService._apply_duckdb_resources(
                    project_id, conn_type, adapter_config
                )
                if conn_type == "duckdb" and (
                    adapter_config.get("path") or ""
                ) not in ("", ":memory:"):
                    release_duckdb_file = True

                try:
                    adapter = get_adapter(conn_type, adapter_config)
                    rendered = _yaml.safe_load(
                        adapter.generate_profiles_yml(profile_name, target_name)
                    )
                except Exception as exc:
                    raise DbtOperationError(
                        "profile setup",
                        f"could not render target '{target_name}' for the "
                        f"{conn_type} connection: {exc}",
                    ) from exc

                # Adapters own their own YAML, so read the output back out of it
                # rather than assuming the key they used.
                rendered_outputs = (
                    ((rendered or {}).get(profile_name) or {}).get("outputs") or {}
                )
                output = rendered_outputs.get(target_name) or next(
                    iter(rendered_outputs.values()), None
                )
                if output is None:
                    raise DbtOperationError(
                        "profile setup",
                        f"the {conn_type} adapter produced no output for target "
                        f"'{target_name}'",
                    )
                outputs[target_name] = output
                conn_types.append(conn_type)
                if default_target is None:
                    default_target = target_name

            if not outputs:
                _fix_in_memory_duckdb_profile(project_path)
                return {}

            # Every path that runs dbt regenerates the profile first, so this is
            # the one place all of them pass through. A warm worker holding the
            # project's DuckDB file open makes the next run fail on the file
            # lock, so hand the file back before dbt is invoked.
            if release_duckdb_file:
                await warm_worker_pool.release_project(project_id)

            try:
                profiles_content = _yaml.safe_dump(
                    {profile_name: {"outputs": outputs, "target": default_target}},
                    sort_keys=False,
                    default_flow_style=False,
                )
                (project_path / "profiles.yml").write_text(profiles_content.strip())
            except Exception as exc:
                raise DbtOperationError(
                    "profile setup",
                    f"could not write profiles.yml for this project: {exc}",
                ) from exc

            logger.debug(
                "Regenerated profiles.yml for project %s (targets=%s types=%s)",
                project_id,
                list(outputs),
                conn_types,
            )
            return dbt_env

        except DbtOperationError:
            raise
        except Exception as exc:
            logger.warning(
                "Could not regenerate profiles.yml for %s: %s", project_id, exc
            )
            return {}

    @staticmethod
    def _apply_duckdb_resources(
        project_id: str, conn_type: str, adapter_config: Dict[str, Any]
    ) -> None:
        """Bound the DuckDB engine for this project's profile.

        Every dbt run is its own process with its own DuckDB instance, and DuckDB
        with no memory_limit takes ~80% of the box: MAX_CONCURRENT_DBT_RUNS of
        those over-commit it and the kernel kills a run instead of DuckDB
        spilling. Applied here because this is the one place every generated
        DuckDB profile passes through.

        A connection that already carries explicit settings is left alone.
        """
        if conn_type != "duckdb" or adapter_config.get("settings"):
            return
        values = duckdb_resources.profile_settings(project_id)
        if values:
            adapter_config["settings"] = values

    @staticmethod
    async def _apply_lakehouse_attach(
        session: AsyncSession,
        project_id: str,
        conn_type: str,
        adapter_config: Dict[str, Any],
    ) -> Dict[str, str]:
        """Attach the project's DuckLake catalog to its dbt profile, if it has one.

        Only DuckDB projects with a lakehouse-bound ingest source get the attach
        block: attaching opens a Postgres connection on every dbt invocation, and
        a project with no ingest source has nothing there to read.

        Returns the env carrying the catalog password, so the secret reaches dbt
        through env_var() instead of being written into profiles.yml.
        """
        if conn_type != "duckdb" or not lakehouse.is_configured():
            return {}

        # Ask whether the table exists before querying it. A failed statement
        # aborts the transaction, and rolling this session back would discard the
        # oidc_sub update resolve_user_id may have made earlier in the request.
        # The table is absent until the ingest migration is applied, and a dbt run
        # must not break over a feature the deployment has not enabled yet.
        exists = await session.execute(
            text("SELECT to_regclass('ingest_sources') IS NOT NULL")
        )
        if not exists.scalar():
            logger.debug("No ingest_sources table; skipping lakehouse attach")
            return {}

        result = await session.execute(
            text(
                "SELECT 1 FROM ingest_sources "
                "WHERE project_id = CAST(:pid AS uuid) AND destination = 'ducklake' "
                "LIMIT 1"
            ),
            {"pid": project_id},
        )
        if result.first() is None:
            return {}

        try:
            entry = lakehouse.dbt_attach_entry(project_id)
            password = lakehouse.catalog_password()
        except lakehouse.LakehouseError as exc:
            logger.warning("Lakehouse attach unavailable for %s: %s", project_id, exc)
            return {}

        extensions = list(adapter_config.get("extensions") or [])
        for extension in lakehouse.DUCKDB_EXTENSIONS:
            if extension not in extensions:
                extensions.append(extension)
        adapter_config["extensions"] = extensions
        adapter_config["attach"] = [*(adapter_config.get("attach") or []), entry]

        return {lakehouse.CATALOG_PASSWORD_ENV: password} if password else {}

    @staticmethod
    async def _load_persisted_environment(
        session: Optional[AsyncSession], project_id: str, user_id: Optional[str]
    ) -> Dict[str, str]:
        if not session or not user_id:
            return {}
        result = await session.execute(
            text(
                "SELECT name, value_encrypted "
                "FROM dbt_environment_variables "
                "WHERE project_id = CAST(:pid AS uuid) "
                "AND owner = CAST(:uid AS uuid)"
            ),
            {"pid": project_id, "uid": user_id},
        )
        env: Dict[str, str] = {}
        for row in result.mappings().all():
            name = str(row["name"])
            if name not in sanitize_dbt_environment({name: ""}):
                continue
            env[name] = decrypt_secret_or_plaintext(row["value_encrypted"])
        return env

    @staticmethod
    async def _build_dbt_environment(
        session: Optional[AsyncSession],
        project_id: str,
        user_id: Optional[str],
        request_environment: Optional[Dict[str, str]],
        profile_env: Dict[str, str],
    ) -> Dict[str, str]:
        return {
            **sanitize_dbt_environment(request_environment),
            **await DbtService._load_persisted_environment(session, project_id, user_id),
            **profile_env,
        }

    async def run_command(
        self,
        request: DbtCommand,
        session: Optional[AsyncSession] = None,
        user_id: Optional[str] = None,
        *,
        run_id: Optional[str] = None,
        started_at: Optional[datetime] = None,
        persist_start: bool = True,
    ) -> Dict[str, Any]:
        """
        Execute a dbt command with file locking and retry logic.

        Args:
            request: DbtCommand with project_id, command, selector, flags
            session: Optional async DB session to persist run records

        Returns:
            Dict with success, command, stdout, stderr, returncode, run_id
        """
        total_start = time.perf_counter()
        phase_start = time.perf_counter()
        project_path = self.project.get_path_or_raise(request.project_id)
        logger.info(
            "[DBT-PERF] command project_path project_id=%s elapsed_ms=%s",
            request.project_id,
            _elapsed_ms(phase_start),
        )

        profile_env: Dict[str, str] = {}
        if session:
            phase_start = time.perf_counter()
            profile_env = await self._regenerate_profiles_from_db(session, request.project_id, project_path)
            logger.info(
                "[DBT-PERF] command profile_regen project_id=%s elapsed_ms=%s",
                request.project_id,
                _elapsed_ms(phase_start),
            )

        # Parse command - handle both single command and full command string
        if " " in request.command:
            cmd_parts = shlex.split(request.command)
            cmd = ["dbt"] + cmd_parts
            command_name = cmd_parts[0]
        else:
            cmd = ["dbt", request.command]
            command_name = request.command

        if request.selector:
            cmd.extend(["--select", request.selector])

        if request.target:
            # Reaches the dbt CLI, so the shape is checked rather than quoted.
            if not TARGET_NAME_RE.match(request.target):
                raise DbtOperationError(
                    "dbt command",
                    f"invalid target name '{request.target}' - lowercase letters, "
                    "digits and underscores only",
                )
            cmd.extend(["--target", request.target])

        if request.flags:
            cmd.extend(request.flags)

        # Strip any client-provided --profiles-dir (security: always use server path).
        if "--profiles-dir" in cmd:
            cleaned = []
            skip_next = False
            for token in cmd:
                if skip_next:
                    skip_next = False
                    continue
                if token == "--profiles-dir":
                    skip_next = True
                    continue
                if token.startswith("--profiles-dir="):
                    continue
                cleaned.append(token)
            cmd = cleaned

        # Add profiles dir
        cmd.extend(["--profiles-dir", str(project_path)])
        dbt_env = await self._build_dbt_environment(
            session, request.project_id, user_id, request.environment_variables, profile_env
        )

        run_id = run_id or str(uuid.uuid4())
        started_at = started_at or datetime.now(timezone.utc)
        command_str = " ".join(cmd)
        run_results_path = project_path / "target" / "run_results.json"
        run_results_mtime_before = self._get_file_mtime(run_results_path)

        # Save run start to DB (skipped when caller already inserted the row,
        # e.g. the async /dbt/runs endpoint).
        if session and persist_start:
            phase_start = time.perf_counter()
            await self._insert_run_start(
                session, run_id, request.project_id, command_name,
                request.selector, started_at, project_path,
            )
            logger.info(
                "[DBT-PERF] command run_start_insert project_id=%s run_id=%s elapsed_ms=%s",
                request.project_id,
                run_id,
                _elapsed_ms(phase_start),
            )

        try:
            lock_wait_start = time.perf_counter()
            async with global_run_semaphore():
                # Use file lock to prevent concurrent dbt runs on same project
                # Shorter timeout (30s) to fail fast
                async with AsyncFileLock.lock(request.project_id, "dbt_run", timeout=30):
                    logger.info(
                        "[DBT-PERF] command lock_wait project_id=%s run_id=%s elapsed_ms=%s",
                        request.project_id,
                        run_id,
                        _elapsed_ms(lock_wait_start),
                    )
                    # Retry logic for DuckDB lock issues (kept for backward compatibility)
                    max_retries = 3
                    retry_delay = 2
                    returncode = -1
                    stdout = ""
                    stderr = ""

                    for attempt in range(max_retries):
                        phase_start = time.perf_counter()
                        returncode, stdout, stderr = await self._run_dbt_command(
                            cmd,
                            project_path,
                            project_id=request.project_id,
                            env=dbt_env,
                            fallback_process_id=request.project_id,
                            cancellable=True,
                            perf_label=f"command project_id={request.project_id} run_id={run_id}",
                        )
                        logger.info(
                            "[DBT-PERF] command subprocess project_id=%s run_id=%s attempt=%s returncode=%s elapsed_ms=%s cmd=%s",
                            request.project_id,
                            run_id,
                            attempt + 1,
                            returncode,
                            _elapsed_ms(phase_start),
                            command_str,
                        )

                        if returncode != 0 and "Conflicting lock" in (stderr + stdout):
                            if attempt < max_retries - 1:
                                logger.warning(
                                    f"DuckDB lock conflict, retrying in {retry_delay}s..."
                                )
                                await asyncio.sleep(retry_delay)
                                continue
                        break
        except asyncio.CancelledError:
            # User cancelled - ensure lock is released
            await AsyncFileLock.force_release(request.project_id, "dbt_run")
            result = {
                "success": False,
                "command": command_str,
                "stdout": "",
                "stderr": "Command cancelled by user",
                "returncode": -1,
                "cancelled": True,
            }
            if session:
                await self._update_run_complete(
                    session, run_id, status="cancelled", started_at=started_at,
                    logs="", error_message="Command cancelled by user",
                )
            result["run_id"] = run_id
            return result
        except TimeoutError:
            result = {
                "success": False,
                "command": command_str,
                "stdout": "",
                "stderr": "Another dbt operation is in progress. Please wait.",
                "returncode": -1,
                "lock_timeout": True,
            }
            if session:
                await self._update_run_complete(
                    session, run_id, status="error", started_at=started_at,
                    logs="", error_message="Lock timeout - another operation in progress",
                )
            result["run_id"] = run_id
            return result

        # Parse results
        phase_start = time.perf_counter()
        logs = stdout + "\n" + stderr if stderr else stdout
        run_results = self._read_run_results(run_results_path, run_results_mtime_before)
        models_total, models_success, models_error = self._get_dbt_counts(
            stdout, run_results
        )
        logger.info(
            "[DBT-PERF] command parse_results project_id=%s run_id=%s elapsed_ms=%s",
            request.project_id,
            run_id,
            _elapsed_ms(phase_start),
        )

        success = returncode == 0
        if success and command_name == "deps":
            self._invalidate_partial_parse_cache(project_path)

        status = "success" if success else "error"
        error_message = stderr if not success else None

        # Update run in DB
        if session:
            phase_start = time.perf_counter()
            await self._update_run_complete(
                session, run_id, status=status, started_at=started_at,
                logs=logs, error_message=error_message,
                models_total=models_total, models_success=models_success,
                models_error=models_error, results=run_results,
            )
            logger.info(
                "[DBT-PERF] command run_complete_update project_id=%s run_id=%s elapsed_ms=%s",
                request.project_id,
                run_id,
                _elapsed_ms(phase_start),
            )
            if run_results:
                try:
                    phase_start = time.perf_counter()
                    await self._insert_artifacts(
                        session, run_id, project_path, run_results.get("results", [])
                    )
                    logger.info(
                        "[DBT-PERF] command artifacts_insert project_id=%s run_id=%s elapsed_ms=%s",
                        request.project_id,
                        run_id,
                        _elapsed_ms(phase_start),
                    )
                except Exception as exc:
                    await session.rollback()
                    logger.exception("Failed to persist dbt run artifacts: %s", exc)

        result = {
            "success": success,
            "command": command_str,
            "stdout": stdout,
            "stderr": stderr,
            "returncode": returncode,
            "run_id": run_id,
        }
        logger.info(
            "[DBT-PERF] command total project_id=%s run_id=%s elapsed_ms=%s",
            request.project_id,
            run_id,
            _elapsed_ms(total_start),
        )
        return result

    @staticmethod
    async def _insert_run_start(
        session: AsyncSession,
        run_id: str,
        project_id: str,
        command_name: str,
        selector: Optional[str],
        started_at: datetime,
        project_path: Path,
    ) -> None:
        """Insert a new dbt run record with status 'running'."""
        git_commit = None
        try:
            import asyncio as _asyncio
            proc = await _asyncio.create_subprocess_exec(
                "git", "rev-parse", "HEAD",
                cwd=project_path,
                stdout=_asyncio.subprocess.PIPE,
                stderr=_asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()
            if proc.returncode == 0:
                git_commit = stdout.decode().strip()[:40]
        except Exception:
            pass

        valid_commands = {
            "run", "test", "build", "compile", "docs", "deps", "clean",
            "seed", "snapshot", "source_freshness",
        }
        # `dbt source freshness` is two CLI words but one enum value.
        command_name = "source_freshness" if command_name == "source" else command_name
        cmd_enum = command_name if command_name in valid_commands else "run"

        await session.execute(
            text("""
                INSERT INTO dbt_runs (
                    id, project_id, command, selector, status,
                    started_at, git_commit, created_at
                ) VALUES (
                    CAST(:id AS uuid), CAST(:project_id AS uuid), CAST(:command AS run_command),
                    :selector, :status, :started_at, :git_commit, :now
                )
            """),
            {
                "id": run_id,
                "project_id": project_id,
                "command": cmd_enum,
                "selector": selector,
                "status": "running",
                "started_at": started_at,
                "git_commit": git_commit,
                "now": started_at,
            },
        )
        await session.commit()

    @staticmethod
    async def _update_run_complete(
        session: AsyncSession,
        run_id: str,
        *,
        status: str,
        started_at: datetime,
        logs: str = "",
        error_message: Optional[str] = None,
        models_total: int = 0,
        models_success: int = 0,
        models_error: int = 0,
        results: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Update run record with final status and metrics."""
        completed_at = datetime.now(timezone.utc)
        duration_ms = int((completed_at - started_at).total_seconds() * 1000)

        await session.execute(
            text("""
                UPDATE dbt_runs SET
                    status = :status,
                    completed_at = :completed_at,
                    duration_ms = :duration_ms,
                    models_total = :models_total,
                    models_success = :models_success,
                    models_error = :models_error,
                    logs = :logs,
                    error_message = :error_message,
                    results = CAST(:results AS jsonb)
                WHERE id = CAST(:id AS uuid)
            """),
            {
                "id": run_id,
                "status": status,
                "completed_at": completed_at,
                "duration_ms": duration_ms,
                "models_total": models_total,
                "models_success": models_success,
                "models_error": models_error,
                "logs": logs,
                "error_message": error_message,
                "results": json.dumps(results) if results else None,
            },
        )
        await session.commit()

    @staticmethod
    async def _insert_artifacts(
        session: AsyncSession,
        run_id: str,
        project_path: Path,
        results: List[Dict[str, Any]],
    ) -> None:
        """Insert per-model run artifacts from run_results.json."""
        for entry in results:
            artifact_id = str(uuid.uuid4())
            unique_id = entry.get("unique_id", "")
            status = entry.get("status", "unknown")
            execution_time = entry.get("execution_time")
            message = entry.get("message")
            failures = entry.get("failures")

            error_msg = None
            if status in ("error", "fail") and message:
                error_msg = str(message)
            elif failures:
                error_msg = json.dumps(failures)

            timing = entry.get("timing")

            # Try to read compiled SQL for this model
            compiled_code = None
            if unique_id and unique_id.startswith("model."):
                model_name = unique_id.split(".")[-1]
                compiled_path = project_path / "target" / "compiled"
                for sql_file in compiled_path.rglob(f"{model_name}.sql"):
                    try:
                        compiled_code = sql_file.read_text()
                    except Exception:
                        pass
                    break

            await session.execute(
                text("""
                    INSERT INTO dbt_run_artifacts (
                        id, run_id, unique_id, status, execution_time,
                        compiled_code, error, timing, created_at
                    ) VALUES (
                        CAST(:id AS uuid), CAST(:run_id AS uuid), :unique_id,
                        :status, :execution_time, :compiled_code, :error,
                        CAST(:timing AS jsonb), :now
                    )
                """),
                {
                    "id": artifact_id,
                    "run_id": run_id,
                    "unique_id": unique_id,
                    "status": status,
                    "execution_time": execution_time,
                    "compiled_code": compiled_code,
                    "error": error_msg,
                    "timing": json.dumps(timing) if timing else None,
                    "now": datetime.now(timezone.utc),
                },
            )
        if results:
            await session.commit()

    @staticmethod
    def _get_dbt_counts(
        stdout: str, run_results: Optional[Dict[str, Any]]
    ) -> tuple[int, int, int]:
        """Get counts from run_results.json, falling back to stdout parsing."""
        if run_results:
            results = run_results.get("results", [])
            if isinstance(results, list):
                total = len(results)
                success_statuses = {"success", "pass"}
                error_statuses = {"error", "fail"}
                success = sum(
                    1
                    for entry in results
                    if isinstance(entry, dict) and entry.get("status") in success_statuses
                )
                error = sum(
                    1
                    for entry in results
                    if isinstance(entry, dict) and entry.get("status") in error_statuses
                )
                return total, success, error

        return DbtService._parse_dbt_counts(stdout)

    @staticmethod
    def _parse_dbt_counts(stdout: str) -> tuple[int, int, int]:
        """Parse dbt stdout for model pass/error/total counts."""
        total = success = error = 0

        for line in stdout.splitlines():
            match = re.search(r"PASS=(\d+).*ERROR=(\d+).*TOTAL=(\d+)", line)
            if match:
                success = int(match.group(1))
                error = int(match.group(2))
                total = int(match.group(3))
                break

        if total == 0:
            # Try legacy format: "Finished running X view models..."
            match = re.search(r"Finished running (\d+)", stdout)
            if match:
                total = int(match.group(1))
                if "error" not in stdout.lower():
                    success = total

        return total, success, error

    @staticmethod
    def _get_file_mtime(path: Path) -> Optional[int]:
        """Return file mtime in nanoseconds, or None if the file is absent."""
        try:
            return path.stat().st_mtime_ns
        except OSError:
            return None

    @staticmethod
    def _read_run_results(
        results_path: Path, previous_mtime_ns: Optional[int]
    ) -> Optional[Dict[str, Any]]:
        """Read target/run_results.json only if this dbt invocation updated it."""
        if not results_path.exists():
            return None
        try:
            current_mtime_ns = results_path.stat().st_mtime_ns
            if previous_mtime_ns is not None and current_mtime_ns <= previous_mtime_ns:
                return None
            return json.loads(results_path.read_text())
        except (json.JSONDecodeError, OSError):
            return None

    async def compile_model(
        self,
        request: CompileRequest,
        session: Optional[AsyncSession] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Compile a specific dbt model and return SQL.

        Args:
            request: CompileRequest with project_id and model_path

        Returns:
            Dict with success, model, compiled_sql, output
        """
        total_start = time.perf_counter()
        phase_start = time.perf_counter()
        project_path = self.project.get_path_or_raise(request.project_id)
        logger.info(
            "[DBT-PERF] compile project_path project_id=%s elapsed_ms=%s",
            request.project_id,
            _elapsed_ms(phase_start),
        )
        profile_env: Dict[str, str] = {}
        if session:
            phase_start = time.perf_counter()
            profile_env = await self._regenerate_profiles_from_db(session, request.project_id, project_path)
            logger.info(
                "[DBT-PERF] compile profile_regen project_id=%s elapsed_ms=%s",
                request.project_id,
                _elapsed_ms(phase_start),
            )
        model_name = Path(request.model_path).stem

        # Use file lock to prevent concurrent compile on same project
        lock_wait_start = time.perf_counter()
        async with AsyncFileLock.lock(request.project_id, "compile"):
            logger.info(
                "[DBT-PERF] compile lock_wait project_id=%s elapsed_ms=%s",
                request.project_id,
                _elapsed_ms(lock_wait_start),
            )
            cmd = [
                "dbt",
                "compile",
                "--select",
                model_name,
            ]
            if request.additional_args:
                cmd.extend(shlex.split(request.additional_args))

            # Strip any client-provided --profiles-dir (security: always use server path).
            if "--profiles-dir" in cmd:
                cleaned = []
                skip_next = False
                for token in cmd:
                    if skip_next:
                        skip_next = False
                        continue
                    if token == "--profiles-dir":
                        skip_next = True
                        continue
                    if token.startswith("--profiles-dir="):
                        continue
                    cleaned.append(token)
                cmd = cleaned

            cmd.extend(["--profiles-dir", str(project_path)])
            dbt_env = await self._build_dbt_environment(
                session, request.project_id, user_id, request.environment_variables, profile_env
            )

            phase_start = time.perf_counter()
            returncode, stdout, stderr = await self._run_dbt_command(
                cmd,
                project_path,
                project_id=request.project_id,
                env=dbt_env,
                perf_label=f"compile project_id={request.project_id} model={model_name}",
            )
            logger.info(
                "[DBT-PERF] compile execution project_id=%s model=%s returncode=%s elapsed_ms=%s cmd=%s",
                request.project_id,
                model_name,
                returncode,
                _elapsed_ms(phase_start),
                " ".join(cmd),
            )

            if returncode != 0:
                return {
                    "success": False,
                    "model": model_name,
                    "compiled_sql": "",
                    "error": stderr or stdout,
                    "output": stdout,
                }

            # Read compiled SQL from target
            compiled_path = project_path / "target" / "compiled"
            compiled_sql = ""

            phase_start = time.perf_counter()
            for sql_file in compiled_path.rglob(f"{model_name}.sql"):
                compiled_sql = sql_file.read_text()
                break
            logger.info(
                "[DBT-PERF] compile read_compiled_sql project_id=%s model=%s elapsed_ms=%s",
                request.project_id,
                model_name,
                _elapsed_ms(phase_start),
            )

        logger.info(
            "[DBT-PERF] compile total project_id=%s model=%s elapsed_ms=%s",
            request.project_id,
            model_name,
            _elapsed_ms(total_start),
        )
        return {
            "success": True,
            "model": model_name,
            "compiled_sql": compiled_sql,
            "output": stdout,
        }

    def _detect_duckdb_corruption(
        self, error_output: str, project_path: Path
    ) -> Optional[Dict[str, Any]]:
        """
        Detect if error is related to DuckDB corruption and extract file path.

        Args:
            error_output: stderr or stdout from dbt command
            project_path: Path to project directory

        Returns:
            Dict with corruption info or None if not a corruption error
        """
        error_lower = error_output.lower()

        # Check for corruption indicators
        is_corruption = any(
            [
                "not a valid duckdb database" in error_lower,
                "io error" in error_lower and "duckdb" in error_lower,
                "database file is malformed" in error_lower,
                "file is encrypted or is not a database" in error_lower,
            ]
        )

        if not is_corruption:
            return None

        # Try to extract file path from error message
        import re

        path_match = re.search(r'["\']([^"\']+\.duckdb)["\']', error_output)
        corrupted_file = None

        if path_match:
            corrupted_file = path_match.group(1)
        else:
            # Check for files in project directory
            for duckdb_file in project_path.glob("*.duckdb"):
                corrupted_file = str(duckdb_file)
                break

        return {
            "is_corrupted": True,
            "file_path": corrupted_file,
            "suggestion": (
                f"Delete the corrupted file and run 'dbt run' to recreate it:\n  File: {corrupted_file}"
                if corrupted_file
                else "Check your DuckDB configuration in profiles.yml"
            ),
        }

    async def preview_model(
        self,
        request: PreviewRequest,
        session: Optional[AsyncSession] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Preview model data using dbt show command.

        For in-memory DuckDB, this will automatically build upstream dependencies
        first to ensure all required tables exist in the same database.

        Args:
            request: PreviewRequest with project_id, model_path, limit

        Returns:
            Dict with success, model, data, columns, row_count, execution_time
        """
        project_path = self.project.get_path_or_raise(request.project_id)
        profile_env: Dict[str, str] = {}
        if session:
            profile_env = await self._regenerate_profiles_from_db(session, request.project_id, project_path)
        model_name = Path(request.model_path).stem

        cmd = [
            "dbt",
            "show",
            "--select",
            model_name,
            "--indirect-selection",
            "empty",
            "--limit",
            str(request.limit),
            "--output",
            "json",
        ]
        if request.additional_args:
            cmd.extend(shlex.split(request.additional_args))

        # Strip any client-provided --profiles-dir (security: always use server path).
        if "--profiles-dir" in cmd:
            cleaned = []
            skip_next = False
            for token in cmd:
                if skip_next:
                    skip_next = False
                    continue
                if token == "--profiles-dir":
                    skip_next = True
                    continue
                if token.startswith("--profiles-dir="):
                    continue
                cleaned.append(token)
            cmd = cleaned

        cmd.extend(["--profiles-dir", str(project_path)])
        dbt_env = await self._build_dbt_environment(
            session, request.project_id, user_id, request.environment_variables, profile_env
        )

        start_time = time.time()

        try:
            # Use file lock with shorter timeout (15s) for preview
            async with AsyncFileLock.lock(request.project_id, "preview", timeout=15):
                # Retry logic for DuckDB lock issues
                max_retries = 3
                retry_delay = 2
                returncode = -1
                stdout = ""
                stderr = ""

                for attempt in range(max_retries):
                    returncode, stdout, stderr = await self._run_dbt_command(
                        cmd,
                        project_path,
                        project_id=request.project_id,
                        env=dbt_env,
                        fallback_process_id=f"{request.project_id}:preview",
                        cancellable=True,
                        perf_label=f"preview project_id={request.project_id}",
                    )

                    if returncode != 0 and "Conflicting lock" in (stderr + stdout):
                        if attempt < max_retries - 1:
                            await asyncio.sleep(retry_delay)
                            continue
                    break

                execution_time = time.time() - start_time

                if returncode != 0:
                    error_msg = stderr or stdout

                    # Check if it's a DuckDB corruption error
                    corruption_info = self._detect_duckdb_corruption(
                        error_msg, project_path
                    )

                    result = {
                        "success": False,
                        "model": model_name,
                        "data": [],
                        "columns": [],
                        "row_count": 0,
                        "execution_time": execution_time,
                        "error": error_msg,
                    }

                    # Add corruption-specific information
                    if corruption_info:
                        result.update(
                            {
                                "corrupted": True,
                                "corrupted_file": corruption_info["file_path"],
                                "suggestion": corruption_info["suggestion"],
                            }
                        )

                    return result

                # Parse output
                data, columns = self._parse_dbt_show_output(stdout)
                column_types = self._get_preview_column_types(project_path, model_name, columns)
        except asyncio.CancelledError:
            # User clicked Cancel button - force release lock
            await AsyncFileLock.force_release(request.project_id, "preview")
            return {
                "success": False,
                "model": model_name,
                "data": [],
                "columns": [],
                "row_count": 0,
                "execution_time": time.time() - start_time,
                "error": "Preview cancelled by user",
                "cancelled": True,
            }
        except TimeoutError:
            return {
                "success": False,
                "model": model_name,
                "data": [],
                "columns": [],
                "row_count": 0,
                "execution_time": time.time() - start_time,
                "error": "Another preview is in progress. Please wait or cancel the current operation.",
                "lock_timeout": True,
            }

        return {
            "success": True,
            "model": model_name,
            "data": data,
            "columns": columns,
            "column_types": column_types,
            "row_count": len(data),
            "execution_time": time.time() - start_time,
            "output": stdout,
        }

    async def explain_model(
        self,
        request: ExplainRequest,
        session: Optional[AsyncSession] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Compile a model, then run an estimated EXPLAIN through dbt show --inline."""
        start_time = time.time()
        model_name = Path(request.model_path).stem

        compile_result = await self.compile_model(
            CompileRequest(
                project_id=request.project_id,
                model_path=request.model_path,
                additional_args=request.additional_args,
                environment_variables=request.environment_variables,
            ),
            session=session,
            user_id=user_id,
        )
        if not compile_result.get("success"):
            return {
                "success": False,
                "model": model_name,
                "adapter": "unknown",
                "mode": "Estimated",
                "plan": "",
                "signals": [],
                "execution_time": time.time() - start_time,
                "error": compile_result.get("error") or "Compile failed",
                "compiled_sql": "",
                "stage": "compile",
            }

        compiled_sql = (compile_result.get("compiled_sql") or "").strip().rstrip(";")
        if not compiled_sql:
            return {
                "success": False,
                "model": model_name,
                "adapter": "unknown",
                "mode": "Estimated",
                "plan": "",
                "signals": [],
                "execution_time": time.time() - start_time,
                "error": "Compiled SQL is empty.",
                "compiled_sql": "",
                "stage": "compile",
            }

        adapter = self._get_adapter_name(request.project_id)
        explain_sql = self._build_explain_sql(adapter, compiled_sql)
        direct_result: Optional[Dict[str, Any]] = None
        if adapter.lower().startswith("dremio"):
            direct_start = time.perf_counter()
            direct_result = await self._try_dremio_rest_explain(
                request.project_id,
                explain_sql,
                session=session,
                user_id=user_id,
                environment_variables=request.environment_variables,
            )
            logger.info(
                "[DBT-PERF] explain dremio_rest project_id=%s model=%s attempted=%s success=%s elapsed_ms=%s",
                request.project_id,
                model_name,
                direct_result is not None,
                bool(direct_result and direct_result.get("success")),
                _elapsed_ms(direct_start),
            )
            if direct_result and direct_result.get("success"):
                rows = direct_result.get("data") or []
                columns = direct_result.get("columns") or []
                plan = self._format_explain_rows(rows, columns)
                execution_time = time.time() - start_time
                return {
                    "success": True,
                    "model": model_name,
                    "adapter": adapter,
                    "mode": "Estimated",
                    "plan": plan,
                    "signals": self._detect_explain_signals(plan),
                    "execution_time": execution_time,
                    "compiled_sql": compiled_sql,
                }

        query_result = await self.query_warehouse(
            QueryRequest(
                project_id=request.project_id,
                sql=explain_sql,
                limit=1000,
                environment_variables=request.environment_variables,
            ),
            session=session,
            user_id=user_id,
        )

        execution_time = time.time() - start_time
        if not query_result.get("success"):
            return {
                "success": False,
                "model": model_name,
                "adapter": adapter,
                "mode": "Estimated",
                "plan": "",
                "signals": [],
                "execution_time": execution_time,
                "error": query_result.get("error") or "Explain failed",
                "compiled_sql": compiled_sql,
                "stage": "explain",
            }

        rows = query_result.get("data") or []
        columns = query_result.get("columns") or []
        plan = self._format_explain_rows(rows, columns)

        return {
            "success": True,
            "model": model_name,
            "adapter": adapter,
            "mode": "Estimated",
            "plan": plan,
            "signals": self._detect_explain_signals(plan),
            "execution_time": execution_time,
            "compiled_sql": compiled_sql,
        }

    def _get_adapter_name(self, project_id: str) -> str:
        profile_path = self.project.get_path_or_raise(project_id) / "profiles.yml"
        try:
            text_content = profile_path.read_text()
        except OSError:
            return "unknown"
        match = re.search(r"^\s*type:\s*([A-Za-z0-9_-]+)\s*$", text_content, re.MULTILINE)
        return match.group(1) if match else "unknown"

    async def _try_dremio_rest_explain(
        self,
        project_id: str,
        explain_sql: str,
        *,
        session: Optional[AsyncSession],
        user_id: Optional[str],
        environment_variables: Optional[Dict[str, str]],
    ) -> Optional[Dict[str, Any]]:
        project_path = self.project.get_path_or_raise(project_id)
        profile_env: Dict[str, str] = {}
        if session:
            profile_env = await self._regenerate_profiles_from_db(
                session, project_id, project_path
            )
        profile_env = await self._build_dbt_environment(
            session, project_id, user_id, environment_variables, profile_env
        )

        config = self._load_dremio_profile_config(project_path, profile_env)
        if not config:
            return None

        try:
            return await self._run_dremio_rest_sql(config, explain_sql, limit=1)
        except Exception as exc:
            logger.warning(
                "Dremio REST explain failed for project %s; falling back to dbt show: %s",
                project_id,
                exc,
            )
            return None

    @staticmethod
    def _resolve_profile_secret(value: Any, env: Dict[str, str]) -> str:
        raw = "" if value is None else str(value)
        match = re.search(r"env_var\(['\"]([^'\"]+)['\"]\)", raw)
        if match:
            return env.get(match.group(1), "")
        return raw

    @staticmethod
    def _load_dremio_profile_config(
        project_path: Path, env: Dict[str, str]
    ) -> Optional[Dict[str, Any]]:
        import yaml

        dbt_project_path = project_path / "dbt_project.yml"
        profiles_path = project_path / "profiles.yml"
        if not dbt_project_path.exists() or not profiles_path.exists():
            return None

        dbt_project = yaml.safe_load(dbt_project_path.read_text()) or {}
        profiles = yaml.safe_load(profiles_path.read_text()) or {}
        profile_name = dbt_project.get("profile") or dbt_project.get("name")
        profile = profiles.get(profile_name) or (next(iter(profiles.values()), None) if profiles else None)
        if not isinstance(profile, dict):
            return None

        target_name = profile.get("target") or "dev"
        outputs = profile.get("outputs") or {}
        output = outputs.get(target_name) or (next(iter(outputs.values()), None) if outputs else None)
        if not isinstance(output, dict) or str(output.get("type", "")).lower() != "dremio":
            return None

        config = dict(output)
        config["password"] = DbtService._resolve_profile_secret(
            config.get("password"), env
        )
        config["pat"] = DbtService._resolve_profile_secret(config.get("pat"), env)
        return config

    @staticmethod
    def _dremio_base_url(config: Dict[str, Any]) -> str:
        use_ssl = bool(config.get("use_ssl"))
        if config.get("cloud_host"):
            return f"https://{config['cloud_host']}"
        host = config.get("software_host") or config.get("host")
        port = config.get("port") or 9047
        scheme = "https" if use_ssl else "http"
        return f"{scheme}://{host}:{port}"

    @staticmethod
    async def _dremio_auth_headers(
        client: httpx.AsyncClient, base_url: str, config: Dict[str, Any]
    ) -> Dict[str, str]:
        password = config.get("password")
        user = config.get("user") or config.get("username")
        if password and user:
            response = await client.post(
                f"{base_url}/apiv2/login",
                json={"userName": user, "password": password},
            )
            response.raise_for_status()
            token = response.json().get("token")
            if token:
                return {"Authorization": f"_dremio{token}"}

        pat = config.get("pat")
        if pat:
            return {"Authorization": f"Bearer {pat}"}
        return {}

    @staticmethod
    async def _run_dremio_rest_sql(
        config: Dict[str, Any], sql: str, *, limit: int = 1
    ) -> Dict[str, Any]:
        base_url = DbtService._dremio_base_url(config)
        terminal_states = {"COMPLETED", "FAILED", "CANCELED", "CANCELLED"}
        running_states = {"RUNNING", "PLANNING", "STARTING", "METADATA_RETRIEVAL", "QUEUED", "PENDING"}
        context = []
        dremio_space = str(config.get("dremio_space") or "").strip()
        dremio_folder = str(config.get("dremio_space_folder") or "").strip()
        if dremio_space:
            context.append(dremio_space)
        if dremio_folder:
            context.extend(part for part in dremio_folder.split(".") if part)

        async with httpx.AsyncClient(timeout=settings.dbt_inline_query_timeout) as client:
            headers = await DbtService._dremio_auth_headers(client, base_url, config)
            headers = {**headers, "Content-Type": "application/json"}
            payload: Dict[str, Any] = {"sql": sql}
            if context:
                payload["context"] = context
            submit = await client.post(
                f"{base_url}/api/v3/sql",
                headers=headers,
                json=payload,
            )
            submit.raise_for_status()
            job_id = submit.json().get("id")
            if not job_id:
                return {
                    "success": False,
                    "data": [],
                    "columns": [],
                    "row_count": 0,
                    "error": "Dremio did not return a job id.",
                }

            deadline = time.monotonic() + settings.dbt_inline_query_timeout
            state = "RUNNING"
            job_payload: Dict[str, Any] = {}
            while time.monotonic() < deadline:
                await asyncio.sleep(0.2)
                status_resp = await client.get(
                    f"{base_url}/api/v3/job/{job_id}",
                    headers=headers,
                )
                status_resp.raise_for_status()
                job_payload = status_resp.json()
                state = str(job_payload.get("jobState") or "").upper()
                if state in terminal_states:
                    break
                if state and state not in running_states:
                    break

            if state != "COMPLETED":
                return {
                    "success": False,
                    "data": [],
                    "columns": [],
                    "row_count": 0,
                    "error": job_payload.get("errorMessage")
                    or f"Dremio job {job_id} ended with state {state or 'unknown'}.",
                }

            results_resp = await client.get(
                f"{base_url}/api/v3/job/{job_id}/results",
                headers=headers,
                params={"limit": limit},
            )
            results_resp.raise_for_status()
            results = results_resp.json()
            rows = results.get("rows") or []
            schema = results.get("schema") or []
            columns = [
                str(column.get("name"))
                for column in schema
                if isinstance(column, dict) and column.get("name")
            ]
            if not columns and rows and isinstance(rows[0], dict):
                columns = list(rows[0].keys())
            return {
                "success": True,
                "data": rows,
                "columns": columns,
                "row_count": len(rows),
                "job_id": job_id,
            }

    @staticmethod
    def _build_explain_sql(adapter: str, compiled_sql: str) -> str:
        adapter_name = (adapter or "").lower()
        if adapter_name.startswith("dremio"):
            return f"EXPLAIN PLAN FOR {compiled_sql}"
        return f"EXPLAIN {compiled_sql}"

    @staticmethod
    def _is_allowed_inline_sql(sql: str) -> bool:
        lowered_sql = sql.strip().lower()
        is_select = lowered_sql.startswith("select") or lowered_sql.startswith("with")
        is_explain = bool(
            re.match(
                r"^explain\s+"
                r"(?!(?:analyze)\b)"
                r"(?:(?:plan|json)\s+for\s+|\([^)]*\)\s*)?"
                r"(select|with)\b",
                lowered_sql,
            )
        )
        return is_select or is_explain

    @staticmethod
    def _format_explain_rows(rows: List[Dict[str, Any]], columns: List[str]) -> str:
        if not rows:
            return "No query plan returned."

        preferred = [
            "explain_value",
            "QUERY PLAN",
            "query_plan",
            "plan",
            "EXPLAIN",
            "physical_plan",
            "logical_plan",
        ]
        for column in preferred:
            if column in columns:
                return "\n".join(str(row.get(column, "")) for row in rows if row.get(column) is not None)

        if len(columns) == 1:
            column = columns[0]
            return "\n".join(str(row.get(column, "")) for row in rows if row.get(column) is not None)

        lines = []
        for row in rows:
            lines.append(" | ".join(f"{column}: {row.get(column, '')}" for column in columns))
        return "\n".join(lines)

    @staticmethod
    def _detect_explain_signals(plan: str) -> List[str]:
        normalized = plan.lower()
        signals = []
        if "seq scan" in normalized or "table scan" in normalized or "full scan" in normalized:
            signals.append("Full scan")
        if "estimated rows" in normalized or "rows=" in normalized or "cardinality" in normalized:
            signals.append("Large estimated rows")
        if "sort" in normalized or "order by" in normalized:
            signals.append("Sort")
        if "hash join" in normalized:
            signals.append("Hash join")
        if "filter" not in normalized and ("scan" in normalized or "join" in normalized):
            signals.append("No filter")
        return signals

    def _get_preview_column_types(
        self, project_path: Path, model_name: str, columns: List[str]
    ) -> Dict[str, str]:
        """Return known dbt artifact types without running extra warehouse work."""
        if not columns:
            return {}

        manifest_path = project_path / "target" / "manifest.json"
        if not manifest_path.exists():
            return {}

        try:
            manifest = json.loads(manifest_path.read_text())
        except Exception:
            return {}

        catalog: Dict[str, Any] = {}
        catalog_path = project_path / "target" / "catalog.json"
        if catalog_path.exists():
            try:
                catalog = json.loads(catalog_path.read_text())
            except Exception:
                catalog = {}

        model_node: Optional[Dict[str, Any]] = None
        model_unique_id: Optional[str] = None
        for unique_id, node in (manifest.get("nodes") or {}).items():
            if not isinstance(node, dict) or node.get("resource_type") != "model":
                continue
            if node.get("name") == model_name or unique_id.endswith(f".{model_name}"):
                model_node = node
                model_unique_id = unique_id
                break

        if not model_node:
            return {}

        manifest_columns = model_node.get("columns") or {}
        if not isinstance(manifest_columns, dict):
            manifest_columns = {}

        catalog_columns = (
            ((catalog.get("nodes") or {}).get(model_unique_id or "") or {}).get("columns")
            or {}
        )
        if not isinstance(catalog_columns, dict):
            catalog_columns = {}

        known_types: Dict[str, str] = {}
        for name in set(manifest_columns.keys()) | set(catalog_columns.keys()):
            manifest_col = manifest_columns.get(name) or {}
            catalog_col = catalog_columns.get(name) or {}
            if not isinstance(manifest_col, dict):
                manifest_col = {}
            if not isinstance(catalog_col, dict):
                catalog_col = {}

            data_type = (
                manifest_col.get("data_type")
                or manifest_col.get("dtype")
                or catalog_col.get("type")
            )
            if data_type:
                known_types[name.lower()] = str(data_type)

        return {
            column: known_types[column.lower()]
            for column in columns
            if column.lower() in known_types
        }

    async def query_warehouse(
        self,
        request: QueryRequest,
        session: Optional[AsyncSession] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run a read-only inline SELECT against the warehouse via dbt show.

        Reuses the project's configured connection (no separate credential
        handling). Enforces read-only (SELECT/WITH only) and a row limit.
        """
        project_path = self.project.get_path_or_raise(request.project_id)
        profile_env: Dict[str, str] = {}
        if session:
            profile_env = await self._regenerate_profiles_from_db(session, request.project_id, project_path)
        sql = (request.sql or "").strip().rstrip(";")
        if not self._is_allowed_inline_sql(sql):
            return {
                "success": False,
                "data": [],
                "columns": [],
                "row_count": 0,
                "error": "Only read-only SELECT/WITH queries and estimated EXPLAIN plans are allowed.",
            }

        dbt_env = await self._build_dbt_environment(
            session, request.project_id, user_id, request.environment_variables, profile_env
        )

        cmd = [
            "dbt",
            "show",
            "--inline",
            sql,
            "--limit",
            str(request.limit),
            "--output",
            "json",
            "--profiles-dir",
            str(project_path),
        ]
        if request.target:
            # Shape-checked, not quoted: it becomes a CLI argument. Same rule as
            # run_command - an ad-hoc query must be able to read prod without
            # being a second way to smuggle arguments into dbt.
            if not TARGET_NAME_RE.match(request.target):
                return {
                    "success": False,
                    "data": [],
                    "columns": [],
                    "row_count": 0,
                    "error": f"invalid target name '{request.target}'",
                }
            cmd.extend(["--target", request.target])
        start_time = time.time()
        try:
            async with AsyncFileLock.lock(request.project_id, "query", timeout=30):
                returncode, stdout, stderr = await self._run_dbt_command(
                    cmd,
                    project_path,
                    project_id=request.project_id,
                    env=dbt_env,
                    fallback_process_id=f"{request.project_id}:query",
                    cancellable=True,
                    timeout=settings.dbt_inline_query_timeout,
                    fallback_on_worker_timeout=False,
                    perf_label=f"query project_id={request.project_id}",
                )
                execution_time = time.time() - start_time
                if returncode != 0:
                    return {
                        "success": False,
                        "data": [],
                        "columns": [],
                        "row_count": 0,
                        "execution_time": execution_time,
                        "error": stderr or stdout,
                    }
                data, columns = self._parse_dbt_show_output(stdout)
        except TimeoutError:
            return {
                "success": False,
                "data": [],
                "columns": [],
                "row_count": 0,
                "execution_time": time.time() - start_time,
                "error": "Another query is in progress. Please wait.",
                "lock_timeout": True,
            }
        return {
            "success": True,
            "data": data,
            "columns": columns,
            "row_count": len(data),
            "execution_time": time.time() - start_time,
        }

    def _parse_dbt_show_output(self, stdout: str) -> tuple[List[Dict], List[str]]:
        """Parse dbt show output to extract data and columns."""
        data = []
        columns = []

        try:
            # Try JSON format first
            json_match = re.search(r'\{[\s\S]*"show"[\s\S]*\}', stdout)
            if json_match:
                json_obj = json.loads(json_match.group())
                if "show" in json_obj and isinstance(json_obj["show"], list):
                    data = json_obj["show"]
                    columns = list(data[0].keys()) if data else []
                    return data, columns

            # Try array format
            array_match = re.search(r"\[[\s\S]*\]", stdout)
            if array_match:
                json_data = json.loads(array_match.group())
                if json_data and len(json_data) > 0:
                    data = json_data
                    columns = list(json_data[0].keys()) if json_data else []
                    return data, columns

            # Try line-by-line JSON
            for line in stdout.strip().split("\n"):
                line = line.strip()
                if line.startswith("{") and line.endswith("}"):
                    try:
                        row = json.loads(line)
                        if not columns:
                            columns = list(row.keys())
                        data.append(row)
                    except json.JSONDecodeError:
                        continue

            if data:
                return data, columns

        except (json.JSONDecodeError, Exception):
            pass

        # Fallback to table parsing
        return self._parse_table_output(stdout)

    def _parse_table_output(self, stdout: str) -> tuple[List[Dict], List[str]]:
        """Parse table-formatted output from dbt show."""
        data = []
        columns = []
        in_table = False

        for line in stdout.strip().split("\n"):
            if not line.strip() or line.strip().startswith("---"):
                continue

            stripped = line.strip()
            if stripped and all(c in "-|+ " for c in stripped):
                continue

            if "|" in line:
                parts = [p.strip() for p in line.split("|")]
                parts = [p for p in parts if p]

                if not in_table:
                    columns = parts
                    in_table = True
                else:
                    if len(parts) == len(columns):
                        row: Dict[str, Any] = {}
                        for i, col in enumerate(columns):
                            value = parts[i]
                            try:
                                if "." in value:
                                    row[col] = float(value)
                                else:
                                    row[col] = int(value)
                            except ValueError:
                                if value.lower() in ("null", "none", ""):
                                    row[col] = None
                                else:
                                    row[col] = value
                        data.append(row)

        return data, columns

    @staticmethod
    def _sanitize_dbt_project_name(name: str) -> str:
        """
        Sanitize a string to be a valid dbt project name.

        dbt Identifier regex: ^[^\\d\\W]\\w*$
        - Must start with a letter or underscore
        - Can only contain letters, digits, and underscores
        """
        name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
        validated = re.sub(r"[^a-zA-Z0-9_]", "_", name)
        if validated and not validated[0].isalpha() and validated[0] != "_":
            validated = "_" + validated
        return validated or "_project"

    @staticmethod
    def _placeholder_profiles_yml(profile_name: str) -> str:
        """Editable placeholder profiles.yml for a project with no connection.

        Uses a project-local DuckDB file (never ':memory:', which loses every
        model between dbt processes) so runs work before a connection is
        attached. Replace it by attaching a connection in the UI, or edit by hand.
        """
        get_adapter = _load_connection_adapter_factory()
        target = get_adapter(
            "duckdb", {"settings": duckdb_resources.profile_settings()}
        ).generate_profiles_yml(profile_name)
        return (
            "# Placeholder profile - no connection configured.\n"
            "# Attach a connection in the Develop screen to regenerate this,\n"
            "# or edit the target below manually.\n"
            f"{target}"
        )

    async def init_project(self, request: DbtInitRequest) -> Dict[str, Any]:
        """
        Initialize a new dbt project from scratch.

        Args:
            request: DbtInitRequest with project_id and project_name

        Returns:
            Dict with success, message, path
        """
        import shutil

        project_path = self.project.ensure_exists(request.project_id)
        sanitized_name = self._sanitize_dbt_project_name(request.project_name)

        try:
            # Run dbt init
            cmd = ["dbt", "init", sanitized_name, "--skip-profile-setup"]
            returncode, stdout, stderr = await self._run_dbt_command(
                cmd,
                project_path,
                project_id=request.project_id,
                perf_label=f"init project_id={request.project_id}",
            )

            # Move files from subdirectory to project root if created
            subdir = project_path / sanitized_name
            if subdir.exists():
                for item in subdir.iterdir():
                    dest = project_path / item.name
                    if dest.exists():
                        if dest.is_dir():
                            shutil.rmtree(dest)
                        else:
                            dest.unlink()
                    shutil.move(str(item), str(project_path))
                subdir.rmdir()

            # dbt init --skip-profile-setup writes no profiles.yml. For a
            # no-connection project nothing else creates one, leaving the
            # project without a profile on disk. Write an editable placeholder
            # so the file exists; if a connection is attached later it gets
            # overwritten by _regenerate_profiles_from_db on the next run.
            profiles_path = project_path / "profiles.yml"
            if not profiles_path.exists():
                profiles_path.write_text(
                    self._placeholder_profiles_yml(sanitized_name)
                )

            success = returncode == 0
            return {
                "success": success,
                "message": (
                    "dbt project initialized successfully"
                    if success
                    else "Failed to initialize"
                ),
                "stdout": stdout,
                "stderr": stderr,
                "path": str(project_path),
            }
        except Exception as e:
            logger.error(f"dbt init error: {e}")
            return {"success": False, "message": str(e), "path": str(project_path)}

    # ==================== DOCS OPERATIONS ====================

    # Port range for docs servers
    _min_docs_port = 8081
    _max_docs_port = 8199

    def _is_port_in_use(self, port: int) -> bool:
        """Check if a port is already in use."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(("localhost", port)) == 0

    def _get_used_ports(self) -> set:
        """Get set of ports currently used by docs servers."""
        return {info["port"] for info in self._docs_servers.values()}

    def _allocate_port(self) -> int:
        """Allocate an available port for docs server."""
        used_ports = self._get_used_ports()

        for port in range(self._min_docs_port, self._max_docs_port + 1):
            if port not in used_ports and not self._is_port_in_use(port):
                logger.info(f"Allocated port {port} for docs server")
                return port

        raise Exception(
            f"No available ports in range {self._min_docs_port}-{self._max_docs_port}"
        )

    async def generate_docs(
        self, request: DocsGenerateRequest, session: Optional[AsyncSession] = None
    ) -> Dict[str, Any]:
        """
        Generate dbt documentation.

        Args:
            request: DocsGenerateRequest with project_id and optional select filter

        Returns:
            Dict with success, message, catalog_path, manifest_path
        """
        project_path = self.project.get_path_or_raise(request.project_id)
        profile_env: Dict[str, str] = {}
        if session:
            profile_env = await self._regenerate_profiles_from_db(session, request.project_id, project_path)

        cmd = ["dbt", "docs", "generate", "--profiles-dir", str(project_path)]

        if request.select:
            cmd.extend(["--select", request.select])

        returncode, stdout, stderr = await self._run_dbt_command(
            cmd,
            project_path,
            project_id=request.project_id,
            env=profile_env,
            perf_label=f"docs_generate project_id={request.project_id}",
        )

        if returncode != 0:
            return {
                "success": False,
                "message": stderr or stdout or "Failed to generate docs",
                "stdout": stdout,
                "stderr": stderr,
            }

        # Check if catalog.json and manifest.json exist
        target_path = project_path / "target"
        catalog_path = target_path / "catalog.json"
        manifest_path = target_path / "manifest.json"

        return {
            "success": True,
            "message": "Documentation generated successfully",
            "catalog_path": str(catalog_path) if catalog_path.exists() else None,
            "manifest_path": str(manifest_path) if manifest_path.exists() else None,
            "stdout": stdout,
            "stderr": stderr,
        }

    async def serve_docs(self, request: DocsServeRequest) -> Dict[str, Any]:
        """
        Start dbt docs server as a background process.

        Args:
            request: DocsServeRequest with project_id and optional port

        Returns:
            Dict with success, message, url, port
        """
        project_id = request.project_id
        project_path = self.project.get_path_or_raise(project_id)

        # Check if docs server is already running for this project
        if project_id in self._docs_servers:
            existing = self._docs_servers[project_id]
            return {
                "success": True,
                "message": "Docs server already running",
                "url": existing["url"],
                "port": existing["port"],
            }

        # Check if catalog.json exists
        catalog_path = project_path / "target" / "catalog.json"
        if not catalog_path.exists():
            return {
                "success": False,
                "message": "catalog.json not found. Run 'dbt docs generate' first.",
                "url": None,
                "port": None,
            }

        # Allocate port
        port = request.port or self._allocate_port()

        cmd = [
            "dbt",
            "docs",
            "serve",
            "--port",
            str(port),
            "--profiles-dir",
            str(project_path),
            "--no-browser",  # Don't open browser automatically
        ]

        try:
            # Start process in background
            process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=project_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Wait a bit to see if it starts successfully
            await asyncio.sleep(1)

            if process.returncode is not None:
                # Process already exited - error
                stdout, stderr = await process.communicate()
                return {
                    "success": False,
                    "message": stderr.decode()
                    or stdout.decode()
                    or "Failed to start docs server",
                    "url": None,
                    "port": None,
                }

            # Server started successfully
            url = f"http://localhost:{port}"
            self._docs_servers[project_id] = {
                "process": process,
                "port": port,
                "url": url,
            }

            logger.info(f"Docs server started for {project_id} at {url}")

            return {
                "success": True,
                "message": f"Docs server started at {url}",
                "url": url,
                "port": port,
            }

        except Exception as e:
            logger.error(f"Failed to start docs server: {e}")
            return {"success": False, "message": str(e), "url": None, "port": None}

    async def stop_docs(self, project_id: str) -> Dict[str, Any]:
        """
        Stop running docs server for a project.

        Args:
            project_id: Project identifier

        Returns:
            Dict with success and message
        """
        if project_id not in self._docs_servers:
            return {
                "success": False,
                "message": "No docs server running for this project",
            }

        server_info = self._docs_servers[project_id]
        process = server_info["process"]

        try:
            process.terminate()
            await asyncio.sleep(0.5)
            if process.returncode is None:
                process.kill()

            del self._docs_servers[project_id]
            logger.info(f"Docs server stopped for {project_id}")

            return {"success": True, "message": "Docs server stopped successfully"}
        except Exception as e:
            logger.error(f"Error stopping docs server: {e}")
            return {"success": False, "message": str(e)}

    def get_docs_status(self, project_id: str) -> Dict[str, Any]:
        """
        Get docs server status for a project.

        Args:
            project_id: Project identifier

        Returns:
            Dict with running, url, port, project_id
        """
        if project_id not in self._docs_servers:
            return {
                "running": False,
                "url": None,
                "port": None,
                "project_id": project_id,
            }

        server_info = self._docs_servers[project_id]
        process = server_info["process"]

        # Check if process is still running
        if process.returncode is not None:
            # Process has exited
            del self._docs_servers[project_id]
            return {
                "running": False,
                "url": None,
                "port": None,
                "project_id": project_id,
            }

        return {
            "running": True,
            "url": server_info["url"],
            "port": server_info["port"],
            "project_id": project_id,
        }

    def list_all_docs_servers(self) -> List[Dict[str, Any]]:
        """
        List all active docs servers.

        Returns:
            List of dicts with project_id, url, port, running status
        """
        servers = []

        # Check each server and clean up dead ones
        dead_projects = []

        for project_id, info in self._docs_servers.items():
            process = info["process"]

            if process.returncode is not None:
                # Process has exited
                dead_projects.append(project_id)
                continue

            servers.append(
                {
                    "project_id": project_id,
                    "url": info["url"],
                    "port": info["port"],
                    "running": True,
                }
            )

        # Clean up dead servers
        for project_id in dead_projects:
            del self._docs_servers[project_id]

        return servers

    async def get_lineage(self, request: LineageRequest) -> Dict[str, Any]:
        """Get table and column lineage for a dbt model."""
        project_path = self.project.get_path_or_raise(request.project_id)
        model_name = Path(request.model_path).stem

        try:
            result = get_full_lineage(project_path, model_name)
            return result
        except Exception as e:
            logger.error(f"Lineage error: {e}")
            return {
                "success": False,
                "model": model_name,
                "error": str(e),
                "table_lineage": {"nodes": [], "edges": []},
                "column_lineage": {},
            }
