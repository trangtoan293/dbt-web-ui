"""Ingest router: inspect a source, and stream one load.

An ingest source names an existing Connection to read from and a destination to
write to. It stores no credentials of its own.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import sys
import uuid
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from adapters import get_adapter
from app.config import settings
from app.core.auth import require_user, resolve_user_id
from app.core.crypto import decrypt_secret_or_plaintext
from app.core.db import async_session, get_session
from app.core.file_lock import AsyncFileLock
from app.core.global_semaphore import global_run_semaphore
from app.core.host_guard import HostNotAllowed, assert_host_allowed
from app.models.ingest import DbtSourcesSnippet, IngestRunRequest, IngestTableList
from app.services.dbt_service import build_adapter_config_from_connection_row
from ingest import lakehouse
from ingest.destination import (
    DESTINATION_LAKEHOUSE,
    UnsupportedDestination,
    build_destination,
)
from ingest.runner import RESULT_PREFIX
from ingest.sql_source import (
    UnsupportedSource,
    build_source_url,
    supported_source_types,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Ingest"])

# Dataset names become SQL schema identifiers, so they are validated rather than
# quoted: nothing outside this shape ever reaches a statement.
_DATASET_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
# Widest identifier shape the supported sources accept, still no quotes or dots.
_TABLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,62}$")

_WRITE_DISPOSITIONS = ("append", "replace", "merge")

MAX_LINE_BYTES = 16 * 1024

# Live ingest subprocesses on this runner, keyed by source id. Deliberately not
# CommandService's registry: cancelling a dbt run must not kill an ingest job,
# and vice versa.
_processes: Dict[str, asyncio.subprocess.Process] = {}

_SECRET_PATTERNS = (
    (re.compile(r"password=[^\s'\"]+", re.IGNORECASE), "password=***"),
    (re.compile(r"://([^:/\s]+):[^@\s]+@"), r"://\1:***@"),
)


def _scrub(line: str) -> str:
    """Strip credentials a library may have echoed into its own log output.

    The SSE hub replays buffered lines to any later subscriber, so a leaked
    connection string would outlive the request that produced it.
    """
    for pattern, replacement in _SECRET_PATTERNS:
        line = pattern.sub(replacement, line)
    return line


async def _load_source(
    session: AsyncSession, source_id: str, user_id: str
) -> Dict[str, Any]:
    """Fetch one ingest source the user owns, with its project and connection."""
    result = await session.execute(
        text(
            "SELECT s.id, s.name, s.source_type, s.destination, s.dataset, s.tables, "
            "s.write_disposition, s.primary_key, s.project_id, "
            "p.connection_id AS project_connection_id, "
            "c.connection_type, c.host, c.port, c.database, c.username, "
            "c.password_encrypted, c.extra_config "
            "FROM ingest_sources s "
            "JOIN dbt_projects p ON p.id = s.project_id "
            "JOIN connections c ON c.id = s.source_connection_id "
            "WHERE s.id = CAST(:sid AS uuid) "
            "AND p.created_by = CAST(:uid AS uuid) AND p.deleted_at IS NULL"
        ),
        {"sid": source_id, "uid": user_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Ingest source not found")
    return dict(row)


async def _project_destination_connection(
    session: AsyncSession, connection_id: str | None
) -> Dict[str, Any] | None:
    if not connection_id:
        return None
    result = await session.execute(
        text(
            "SELECT connection_type, host, port, database, username, "
            "password_encrypted, extra_config "
            "FROM connections WHERE id = CAST(:cid AS uuid)"
        ),
        {"cid": str(connection_id)},
    )
    row = result.mappings().first()
    return dict(row) if row else None


def _validated_tables(source: Dict[str, Any], override: list[str] | None) -> list[str]:
    raw = override if override is not None else (source.get("tables") or [])
    if isinstance(raw, str):
        raw = json.loads(raw)
    tables = [str(t) for t in raw]
    if not tables:
        raise HTTPException(
            status_code=400, detail="No tables selected for this source"
        )
    invalid = [t for t in tables if not _TABLE_RE.match(t)]
    if invalid:
        raise HTTPException(
            status_code=400, detail=f"Invalid table name(s): {', '.join(invalid[:5])}"
        )
    stored = source.get("tables")
    if override is not None and stored:
        allowed = set(json.loads(stored) if isinstance(stored, str) else stored)
        extra = [t for t in tables if t not in allowed]
        if extra:
            raise HTTPException(
                status_code=400,
                detail=f"Table(s) not configured on this source: {', '.join(extra[:5])}",
            )
    return tables


def _validated_dataset(source: Dict[str, Any]) -> str:
    dataset = str(source.get("dataset") or "").strip().lower()
    if not _DATASET_RE.match(dataset):
        raise HTTPException(
            status_code=400,
            detail="Dataset must start with a letter and use only lowercase letters, "
            "digits and underscores (max 40 characters)",
        )
    return dataset


def _pipelines_dir(project_id: str) -> Path:
    """dlt keeps incremental cursors here, so it must survive a container restart.

    Left in the container's filesystem, every restart resets the cursor and the
    next load silently re-reads or skips rows.
    """
    path = Path(settings.storage_dir) / "dlt" / str(project_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _build_job_config(
    source: Dict[str, Any],
    destination_connection: Dict[str, Any] | None,
    tables: list[str],
    dataset: str,
    write_disposition: str,
) -> Dict[str, Any]:
    project_id = str(source["project_id"])
    source_secret = decrypt_secret_or_plaintext(source.get("password_encrypted"))
    source_url = build_source_url(source, source_secret)

    kind = str(source.get("destination") or DESTINATION_LAKEHOUSE)
    connection_type = None
    connection_config: Dict[str, Any] = {}
    connection_secret = ""
    if kind != DESTINATION_LAKEHOUSE:
        if not destination_connection:
            raise UnsupportedDestination(
                "this project has no connection attached to load into - attach one, "
                f"or use the '{DESTINATION_LAKEHOUSE}' destination"
            )
        connection_type, connection_config, needs_secret = (
            build_adapter_config_from_connection_row(
                destination_connection, secret_value=None
            )
        )
        if needs_secret:
            connection_secret = decrypt_secret_or_plaintext(
                destination_connection.get("password_encrypted")
            )

    destination = build_destination(
        kind,
        project_id=project_id,
        connection_type=connection_type,
        connection_config=connection_config,
        connection_secret=connection_secret,
    )

    primary_key = source.get("primary_key")
    if isinstance(primary_key, str):
        primary_key = json.loads(primary_key)

    return {
        "project_id": project_id,
        "pipeline_name": f"ingest_{re.sub(r'[^a-z0-9]', '', str(source['id']).lower())[:24]}",
        "pipelines_dir": str(_pipelines_dir(project_id)),
        "dataset": dataset,
        "write_disposition": write_disposition,
        "primary_key": primary_key or None,
        "source": {"type": "sql_database", "url": source_url, "tables": tables},
        "destination": destination,
    }


@router.get("/ingest/meta")
async def ingest_meta() -> Dict[str, Any]:
    """What this deployment can ingest from, and write to."""
    return {
        "source_types": ["sql_database"],
        "source_connection_types": supported_source_types(),
        "destinations": ["connection", DESTINATION_LAKEHOUSE],
        "write_dispositions": list(_WRITE_DISPOSITIONS),
        "lakehouse_configured": lakehouse.is_configured(),
    }


@router.get("/ingest/connections/{connection_id}/tables", response_model=IngestTableList)
async def list_connection_tables(
    connection_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> IngestTableList:
    """List tables on one of the caller's connections, for the table picker.

    Keyed on the connection rather than a saved ingest source, so the picker
    works while the source is still being created - otherwise the first table
    list has to be typed from memory and only becomes browsable after saving.
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    result = await session.execute(
        text(
            "SELECT connection_type, host, port, database, username, "
            "password_encrypted, extra_config "
            "FROM connections "
            "WHERE id = CAST(:cid AS uuid) AND created_by = CAST(:uid AS uuid)"
        ),
        {"cid": connection_id, "uid": user_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Connection not found")
    connection = dict(row)

    if connection["connection_type"] not in supported_source_types():
        return IngestTableList(
            success=False,
            message=f"Ingest cannot read from a {connection['connection_type']} "
            f"connection. Supported: {', '.join(supported_source_types())}",
        )

    try:
        assert_host_allowed(
            str(connection.get("host") or ""), int(connection.get("port") or 0) or None
        )
    except HostNotAllowed as exc:
        return IngestTableList(success=False, message=str(exc))

    conn_type, config, needs_secret = build_adapter_config_from_connection_row(
        connection, secret_value=None
    )
    if needs_secret:
        config = {
            **config,
            "password": decrypt_secret_or_plaintext(connection.get("password_encrypted")),
        }
    try:
        adapter = get_adapter(conn_type, config)
        schema = await adapter.extract_schema()
    except Exception as exc:
        logger.warning("Could not read schema for connection %s: %s", connection_id, exc)
        return IngestTableList(success=False, message=str(exc))

    tables = []
    for table in schema.get("tables", []) if isinstance(schema, dict) else []:
        name = table.get("name") if isinstance(table, dict) else None
        if name and _TABLE_RE.match(str(name)):
            tables.append(str(name))
    return IngestTableList(success=True, tables=sorted(set(tables)))


@router.get("/ingest/sources/{source_id}/dbt-sources", response_model=DbtSourcesSnippet)
async def dbt_sources_snippet(
    source_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> DbtSourcesSnippet:
    """The sources.yml block that makes ingested tables usable from dbt.

    Without this, data lands in the lake and no model can reach it.
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    source = await _load_source(session, source_id, user_id)
    dataset = _validated_dataset(source)
    tables = _validated_tables(source, None)

    is_lake = (
        str(source.get("destination") or DESTINATION_LAKEHOUSE) == DESTINATION_LAKEHOUSE
    )
    database_line = f"    database: {lakehouse.ATTACH_ALIAS}\n" if is_lake else ""
    table_lines = "".join(f"      - name: {t}\n" for t in tables)

    # Only dbt-duckdb can attach a DuckLake catalog, so a project on another
    # warehouse loads into the lake successfully and then cannot read it from
    # dbt. Say so here, where someone comes looking for the wiring.
    warning = ""
    if is_lake:
        project_connection = await _project_destination_connection(
            session, source.get("project_connection_id")
        )
        project_type = (project_connection or {}).get("connection_type")
        if project_type != "duckdb":
            warning = (
                f"# WARNING: this project runs dbt on {project_type or 'no connection'}, "
                "which cannot attach a DuckLake catalog.\n"
                "# The load succeeds, but dbt models here cannot read these tables. Either\n"
                "# switch the source's destination to 'connection', or point the project at a\n"
                "# DuckDB connection. Engines outside dbt (Dremio, Spark, DuckDB CLI) can still\n"
                f"# read the Parquet under {lakehouse.data_dir(str(source['project_id']))}.\n\n"
            )

    content = (
        f"{warning}"
        "version: 2\n\n"
        "sources:\n"
        f"  - name: {dataset}\n"
        f"{database_line}"
        f"    schema: {dataset}\n"
        "    tables:\n"
        f"{table_lines}"
    )
    return DbtSourcesSnippet(success=True, dataset=dataset, content=content)


@router.post("/ingest/sources/{source_id}/cancel")
async def cancel_ingest(
    source_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """Terminate a running load for this source on this runner process."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _load_source(session, source_id, user_id)

    process = _processes.get(source_id)
    if not process or process.returncode is not None:
        return {"success": False, "message": "No ingest running for this source"}
    process.terminate()
    return {"success": True, "message": "Ingest cancelled"}


async def _stream_process(
    config: Dict[str, Any], source_id: str
) -> AsyncIterator[Dict[str, Any]]:
    """Run the ingest subprocess, yielding one event dict per output line.

    Events, not SSE frames: the caller both streams these to the browser and
    writes them to ingest_runs, and re-parsing its own serialised output to
    learn whether the load succeeded would be silly.
    """
    payload = json.dumps(config)
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "ingest.runner",
        cwd=Path(__file__).resolve().parents[2],
        env={**os.environ},
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        limit=MAX_LINE_BYTES + 1024,
    )
    _processes[source_id] = process
    try:
        # The configuration holds a decrypted password: stdin only, never argv.
        process.stdin.write(payload.encode())
        await process.stdin.drain()
        process.stdin.close()

        result: Dict[str, Any] = {}
        async with asyncio.timeout(settings.ingest_subprocess_timeout):
            while True:
                raw = await process.stdout.readline()
                if not raw:
                    break
                line = _scrub(raw.decode(errors="replace").rstrip("\r\n"))
                if len(raw) > MAX_LINE_BYTES:
                    line = line[:MAX_LINE_BYTES] + "...[truncated]"
                if line.startswith(RESULT_PREFIX):
                    try:
                        result = json.loads(line[len(RESULT_PREFIX) :].strip())
                    except json.JSONDecodeError:
                        pass
                    continue
                yield {"type": "log", "message": line}
            await process.wait()

        if process.returncode == 0:
            yield {"type": "completed", **result}
        else:
            yield {
                "type": "error",
                "message": f"Ingest failed with exit code {process.returncode}",
            }
    except TimeoutError:
        process.kill()
        await process.wait()
        yield {
            "type": "error",
            "message": f"Ingest exceeded {settings.ingest_subprocess_timeout}s and was stopped",
        }
    except asyncio.CancelledError:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        raise
    finally:
        _processes.pop(source_id, None)


async def _ingest_runs_available(session: AsyncSession) -> bool:
    """Whether this deployment has the ingest_runs table yet.

    Asked before writing rather than catching the error: a failed statement
    aborts the surrounding Postgres transaction, and a load must not break on a
    migration the deployment has not applied.
    """
    exists = await session.execute(text("SELECT to_regclass('ingest_runs') IS NOT NULL"))
    return bool(exists.scalar())


def _rows_loaded(result: Dict[str, Any]) -> int | None:
    """Total rows from the runner's per-table counts, when it reported any.

    The key is `row_counts` - the same field ingest/runner.py emits after its
    RESULT_PREFIX line. Reading anything else silently records every load as
    having moved no rows.
    """
    counts = result.get("row_counts")
    if not isinstance(counts, dict):
        return None
    total = 0
    for value in counts.values():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            total += int(value)
    return total


class _RunRecorder:
    """Persists one ingest load: a row on start, its outcome at the end.

    Logs are kept as a capped tail. dlt is chatty and a load can run for an
    hour, so storing all of it would make this table the reason Postgres grows -
    the same mistake dbt_runs already makes with unbounded log text.
    """

    def __init__(self, source_id: str, project_id: str) -> None:
        self.source_id = source_id
        self.project_id = project_id
        self.run_id: str | None = None
        self.started_at = datetime.now(timezone.utc)
        self._log: list[str] = []
        self._log_chars = 0

    async def start(self) -> None:
        async with async_session() as session:
            if not await _ingest_runs_available(session):
                return
            run_id = str(uuid.uuid4())
            await session.execute(
                text(
                    """
                    INSERT INTO ingest_runs (id, source_id, project_id, status,
                                             started_at, created_at)
                    VALUES (CAST(:id AS uuid), CAST(:sid AS uuid),
                            CAST(:pid AS uuid), 'running', :at, :at)
                    """
                ),
                {
                    "id": run_id,
                    "sid": self.source_id,
                    "pid": self.project_id,
                    "at": self.started_at,
                },
            )
            await session.commit()
            self.run_id = run_id

    def observe(self, event: Dict[str, Any]) -> None:
        if event.get("type") != "log":
            return
        message = str(event.get("message") or "")
        limit = settings.ingest_run_log_max_chars
        if self._log_chars >= limit:
            return
        self._log.append(message)
        self._log_chars += len(message) + 1

    async def finish(
        self, status: str, result: Dict[str, Any], error: str | None
    ) -> None:
        if not self.run_id:
            return
        completed_at = datetime.now(timezone.utc)
        logs = "\n".join(self._log)[: settings.ingest_run_log_max_chars]
        async with async_session() as session:
            await session.execute(
                text(
                    """
                    UPDATE ingest_runs SET
                        status = :status,
                        completed_at = :completed_at,
                        duration_ms = :duration_ms,
                        rows_loaded = :rows_loaded,
                        tables = CAST(:tables AS jsonb),
                        logs = :logs,
                        error_message = :error
                    WHERE id = CAST(:id AS uuid)
                    """
                ),
                {
                    "id": self.run_id,
                    "status": status,
                    "completed_at": completed_at,
                    "duration_ms": int(
                        (completed_at - self.started_at).total_seconds() * 1000
                    ),
                    "rows_loaded": _rows_loaded(result),
                    "tables": json.dumps(result.get("row_counts"))
                    if result.get("row_counts") is not None
                    else None,
                    "logs": logs,
                    "error": error,
                },
            )
            await session.commit()


@router.get("/ingest/sources/{source_id}/runs")
async def list_ingest_runs(
    source_id: str,
    limit: int = 25,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """History for one source. Ownership is checked by loading the source."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _load_source(session, source_id, user_id)
    if not await _ingest_runs_available(session):
        return {"items": []}

    result = await session.execute(
        text(
            """
            SELECT id, status, started_at, completed_at, duration_ms,
                   rows_loaded, tables, error_message
            FROM ingest_runs
            WHERE source_id = CAST(:sid AS uuid)
            ORDER BY started_at DESC
            LIMIT :limit
            """
        ),
        {"sid": source_id, "limit": max(1, min(limit, 100))},
    )
    return {
        "items": [
            {
                "id": str(row["id"]),
                "status": row["status"],
                "started_at": row["started_at"].isoformat()
                if row["started_at"]
                else None,
                "completed_at": row["completed_at"].isoformat()
                if row["completed_at"]
                else None,
                "duration_ms": row["duration_ms"],
                "rows_loaded": row["rows_loaded"],
                "tables": row["tables"],
                "error_message": row["error_message"],
            }
            for row in result.mappings().all()
        ]
    }


@router.get("/ingest/runs/{run_id}/logs")
async def get_ingest_run_logs(
    run_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> Dict[str, Any]:
    """The stored log tail for one past load."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    if not await _ingest_runs_available(session):
        raise HTTPException(status_code=404, detail="Ingest run not found")
    result = await session.execute(
        text(
            """
            SELECT r.id, r.logs, r.status
            FROM ingest_runs r
            JOIN dbt_projects p ON p.id = r.project_id
            WHERE r.id = CAST(:rid AS uuid)
              AND p.created_by = CAST(:uid AS uuid)
              AND p.deleted_at IS NULL
            """
        ),
        {"rid": run_id, "uid": user_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Ingest run not found")
    return {"id": str(row["id"]), "status": row["status"], "logs": row["logs"] or ""}


@router.post("/sse/ingest/{source_id}")
async def ingest_sse(
    source_id: str,
    body: IngestRunRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    """Run one ingest job, streaming its output as Server-Sent Events."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    source = await _load_source(session, source_id, user_id)

    tables = _validated_tables(source, body.tables)
    dataset = _validated_dataset(source)
    write_disposition = (
        body.write_disposition or source.get("write_disposition") or "append"
    ).lower()
    if write_disposition not in _WRITE_DISPOSITIONS:
        raise HTTPException(
            status_code=400,
            detail=f"write_disposition must be one of {', '.join(_WRITE_DISPOSITIONS)}",
        )

    destination_kind = str(source.get("destination") or DESTINATION_LAKEHOUSE)
    destination_connection = None
    if destination_kind != DESTINATION_LAKEHOUSE:
        destination_connection = await _project_destination_connection(
            session, source.get("project_connection_id")
        )

    try:
        config = _build_job_config(
            source, destination_connection, tables, dataset, write_disposition
        )
    except HostNotAllowed as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except (UnsupportedSource, UnsupportedDestination) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except lakehouse.LakehouseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if body.full_refresh:
        shutil.rmtree(
            Path(config["pipelines_dir"]) / config["pipeline_name"], ignore_errors=True
        )

    project_id = str(source["project_id"])
    needs_duckdb_lock = config["destination"]["kind"] == "duckdb"

    async def event_generator() -> AsyncIterator[str]:
        recorder = _RunRecorder(source_id, project_id)
        await recorder.start()
        status, result, error = "error", {}, None
        yield f"data: {json.dumps({'type': 'started', 'run_id': recorder.run_id, 'dataset': dataset, 'tables': tables})}\n\n"
        try:
            # Ingest counts against the same budget as dbt runs: a 429 is better
            # than an OOM on a box sized for one workload at a time.
            async with global_run_semaphore(), AsyncExitStack() as stack:
                if needs_duckdb_lock:
                    # DuckDB is single-writer and the warm worker pool holds the
                    # file open, so ingest must serialise against dbt runs on the
                    # same resource name. Lakehouse loads skip this by design.
                    await stack.enter_async_context(
                        AsyncFileLock.lock(project_id, "dbt_run", timeout=60)
                    )
                async for event in _stream_process(config, source_id):
                    recorder.observe(event)
                    if event.get("type") == "completed":
                        status, result = "success", event
                    elif event.get("type") == "error":
                        error = str(event.get("message") or "")
                    yield f"data: {json.dumps(event)}\n\n"
        except asyncio.CancelledError:
            # The browser closed the stream. The subprocess is terminated by
            # _stream_process, so the load really did stop.
            status, error = "cancelled", "Client disconnected"
            await recorder.finish(status, result, error)
            raise
        except Exception as exc:
            logger.exception("Ingest failed for source %s", source_id)
            error = str(exc)
            yield f"data: {json.dumps({'type': 'error', 'message': error})}\n\n"
        await recorder.finish(status, result, error)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
