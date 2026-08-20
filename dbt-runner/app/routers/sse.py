"""
SSE router — Server-Sent Events for file watching and dbt command streaming.
Replaces the WebSocket router. No WebSocket dependency.
"""

import asyncio
import json
import logging
import os
import shlex
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_user, resolve_user_id
from app.core.db import async_session, get_session
from app.core.file_lock import AsyncFileLock
from app.core.global_semaphore import global_run_semaphore
from app.core.redis_client import get_redis
from app.services.command import CommandService
from app.services.dbt_service import DbtService
from app.services.file_watcher import file_watcher_manager
from app.services.project import ProjectService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["SSE"])


class _DbtRunLogHub:
    """In-memory fanout for live dbt run logs on this runner process."""

    def __init__(self) -> None:
        self._buffers: dict[str, list[dict]] = {}
        self._queues: dict[str, set[asyncio.Queue]] = {}
        self._terminal: set[str] = set()

    def publish(self, run_id: str, event: dict) -> None:
        buffer = self._buffers.setdefault(run_id, [])
        buffer.append(event)
        if len(buffer) > 5000:
            del buffer[: len(buffer) - 5000]
        if event.get("type") in {"completed", "error"}:
            self._terminal.add(run_id)
            if not self._queues.get(run_id):
                self._buffers.pop(run_id, None)
                self._terminal.discard(run_id)
                return
        for queue in list(self._queues.get(run_id, set())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe(self, run_id: str) -> tuple[asyncio.Queue, list[dict], bool]:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._queues.setdefault(run_id, set()).add(queue)
        return queue, list(self._buffers.get(run_id, [])), run_id in self._terminal

    def unsubscribe(self, run_id: str, queue: asyncio.Queue) -> None:
        queues = self._queues.get(run_id)
        if not queues:
            return
        queues.discard(queue)
        if not queues:
            self._queues.pop(run_id, None)
            if run_id in self._terminal:
                self._buffers.pop(run_id, None)
                self._terminal.discard(run_id)


dbt_run_log_hub = _DbtRunLogHub()


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


@router.get("/sse/files/{project_id}")
async def file_watcher_sse(project_id: str) -> StreamingResponse:
    """
    SSE endpoint for real-time file system events.
    Connect with EventSource. Sends JSON-encoded events as SSE data lines.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)

    file_watcher_manager.set_event_loop(asyncio.get_running_loop())

    project_service = ProjectService()
    try:
        project_service.ensure_exists(project_id)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Project not found: {e}")

    success = await file_watcher_manager.start_watching(project_id, queue)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found or failed to start watcher")

    async def event_generator():
        try:
            yield f'data: {json.dumps({"type": "connected", "project_id": project_id, "message": "File watcher connected successfully"})}\n\n'

            while True:
                try:
                    event_data = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f'data: {json.dumps(event_data)}\n\n'
                except asyncio.TimeoutError:
                    yield f'data: {json.dumps({"type": "ping"})}\n\n'

        except asyncio.CancelledError:
            pass
        finally:
            await file_watcher_manager.stop_watching(project_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class DbtCommandRequest(BaseModel):
    command: str
    selector: str | None = None
    flags: list[str] | None = None
    environment_variables: dict[str, str] | None = None


async def _run_streaming_dbt_command(
    cmd: list[str],
    cwd: Path,
    *,
    project_id: str,
    env: dict[str, str] | None,
    max_line_bytes: int,
    on_line: Callable[[str], Awaitable[None]],
) -> int:
    """Run dbt as a subprocess and emit output as soon as each line arrives."""
    process = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        env={**os.environ, **(env or {})},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        limit=max_line_bytes + 1024,
    )
    CommandService._local_processes[project_id] = process
    await CommandService._register_process(project_id)

    try:
        if process.stdout is None:
            raise RuntimeError("dbt subprocess stdout unavailable")

        while True:
            raw_line = await process.stdout.readline()
            if not raw_line:
                break
            decoded_line = raw_line.decode(errors="replace").rstrip("\r\n")
            if len(raw_line) > max_line_bytes:
                decoded_line = decoded_line[:max_line_bytes] + "...[truncated]"
            await on_line(decoded_line)

        await process.wait()
        if await CommandService._is_cancelled(project_id):
            return -1
        return process.returncode or 0
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
        CommandService._local_processes.pop(project_id, None)
        await CommandService._unregister_process(project_id)


class _SseRunPersistence:
    """Persist one streamed dbt run exactly once after the DB update succeeds."""

    def __init__(
        self,
        *,
        run_id: str,
        started_at: datetime,
        run_results_path: Path,
        run_results_mtime_before: int | None,
        project_path: Path,
        output_lines: list[str],
    ) -> None:
        self.run_id = run_id
        self.started_at = started_at
        self.run_results_path = run_results_path
        self.run_results_mtime_before = run_results_mtime_before
        self.project_path = project_path
        self.output_lines = output_lines
        self.persisted = False

    async def persist_complete(
        self, status: str, error_message: str | None = None
    ) -> None:
        if self.persisted:
            return

        stdout = "\n".join(self.output_lines)
        run_results = DbtService._read_run_results(
            self.run_results_path, self.run_results_mtime_before
        )
        models_total, models_success, models_error = DbtService._get_dbt_counts(
            stdout, run_results
        )
        async with async_session() as db_session:
            await DbtService._update_run_complete(
                db_session,
                self.run_id,
                status=status,
                started_at=self.started_at,
                logs=stdout,
                error_message=error_message,
                models_total=models_total,
                models_success=models_success,
                models_error=models_error,
                results=run_results,
            )
            self.persisted = True
            if run_results:
                try:
                    await DbtService._insert_artifacts(
                        db_session,
                        self.run_id,
                        self.project_path,
                        run_results.get("results", []),
                    )
                except Exception as exc:
                    await db_session.rollback()
                    logger.exception("Failed to persist dbt run artifacts: %s", exc)


async def _verify_project_ownership(
    session: AsyncSession, project_id: str, user_id: str
) -> None:
    result = await session.execute(
        text(
            "SELECT id FROM dbt_projects "
            "WHERE id = CAST(:pid AS uuid) AND created_by = CAST(:uid AS uuid) "
            "AND deleted_at IS NULL"
        ),
        {"pid": project_id, "uid": user_id},
    )
    if not result.first():
        raise HTTPException(status_code=404, detail="Project not found")


async def _verify_run_ownership(
    session: AsyncSession, run_id: str, user_id: str
) -> None:
    result = await session.execute(
        text(
            "SELECT r.id FROM dbt_runs r "
            "JOIN dbt_projects p ON p.id = r.project_id "
            "WHERE r.id = CAST(:rid AS uuid) "
            "AND p.created_by = CAST(:uid AS uuid) "
            "AND p.deleted_at IS NULL"
        ),
        {"rid": run_id, "uid": user_id},
    )
    if not result.first():
        raise HTTPException(status_code=404, detail="Run not found")


@router.get("/sse/dbt-runs/{run_id}/events")
async def dbt_run_events_sse(
    run_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    """SSE endpoint for live log fanout to History run details."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_run_ownership(session, run_id, user_id)

    async def event_generator():
        queue, replay, terminal = dbt_run_log_hub.subscribe(run_id)
        try:
            for event in replay:
                yield f"data: {json.dumps(event)}\n\n"
            if terminal:
                return
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"data: {json.dumps(event)}\n\n"
                    if event.get("type") in {"completed", "error"}:
                        return
                except asyncio.TimeoutError:
                    yield f'data: {json.dumps({"type": "ping"})}\n\n'
        except asyncio.CancelledError:
            pass
        finally:
            dbt_run_log_hub.unsubscribe(run_id, queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/sse/dbt/{project_id}")
async def dbt_sse(
    project_id: str,
    body: DbtCommandRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse:
    """
    SSE endpoint for streaming dbt command output.
    POST body: {"command": "run", "selector": "optional_model"}
    Sends JSON-encoded events as SSE data lines.
    """
    total_start = time.perf_counter()
    phase_start = time.perf_counter()
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    logger.info(
        "[DBT-PERF] sse auth_ownership project_id=%s elapsed_ms=%s",
        project_id,
        _elapsed_ms(phase_start),
    )

    project_service = ProjectService()
    try:
        phase_start = time.perf_counter()
        project_path = await project_service.get_or_sync(project_id)
        logger.info(
            "[DBT-PERF] sse project_get_or_sync project_id=%s elapsed_ms=%s",
            project_id,
            _elapsed_ms(phase_start),
        )
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Project not found: {e}")

    # Build dbt command list
    command = body.command
    selector = body.selector

    command_parts = shlex.split(command)
    cmd = ["dbt"] + command_parts
    command_name = command_parts[0] if command_parts else "run"

    if selector and "--select" not in cmd:
        cmd.extend(["--select", selector])

    if body.flags:
        cmd.extend(body.flags)

    # Strip any client-provided --profiles-dir (security: always use server path).
    # Handles both `--profiles-dir VAL` and `--profiles-dir=VAL` forms.
    if "--profiles-dir" in cmd:
        cleaned: list[str] = []
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
    dbt_env = await DbtService._build_dbt_environment(
        session, project_id, user_id, body.environment_variables, {}
    )

    # Regenerate profiles.yml from DB before running
    try:
        phase_start = time.perf_counter()
        profile_env = await DbtService._regenerate_profiles_from_db(session, project_id, project_path)
        dbt_env = await DbtService._build_dbt_environment(
            session, project_id, user_id, body.environment_variables, profile_env
        )
        logger.info(
            "[DBT-PERF] sse profile_regen project_id=%s elapsed_ms=%s",
            project_id,
            _elapsed_ms(phase_start),
        )
    except Exception as regen_err:
        logger.warning(f"[dbt_sse] profiles regen failed: {regen_err}")

    MAX_LINE_BYTES = 64 * 1024  # 64KB per line; dbt output is line-oriented
    MAX_LOG_CHARS = 1024 * 1024
    run_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)
    run_results_path = project_path / "target" / "run_results.json"
    run_results_mtime_before = DbtService._get_file_mtime(run_results_path)
    phase_start = time.perf_counter()
    await DbtService._insert_run_start(
        session, run_id, project_id, command_name, selector, started_at, project_path
    )
    logger.info(
        "[DBT-PERF] sse run_start_insert project_id=%s run_id=%s elapsed_ms=%s",
        project_id,
        run_id,
        _elapsed_ms(phase_start),
    )

    async def stream_dbt():
        output_lines: list[str] = []
        log_chars = 0
        returncode = -1
        output_queue: asyncio.Queue[str | None] = asyncio.Queue()
        persistence = _SseRunPersistence(
            run_id=run_id,
            started_at=started_at,
            run_results_path=run_results_path,
            run_results_mtime_before=run_results_mtime_before,
            project_path=project_path,
            output_lines=output_lines,
        )

        try:
            started_event = {"type": "started", "command": " ".join(cmd)}
            dbt_run_log_hub.publish(run_id, started_event)
            yield f"data: {json.dumps(started_event)}\n\n"

            lock_wait_start = time.perf_counter()
            async with global_run_semaphore():
                async with AsyncFileLock.lock(project_id, "dbt_run", timeout=30):
                    logger.info(
                        "[DBT-PERF] sse lock_wait project_id=%s run_id=%s elapsed_ms=%s",
                        project_id,
                        run_id,
                        _elapsed_ms(lock_wait_start),
                    )
                    subprocess_start = time.perf_counter()

                    async def enqueue_output(line: str) -> None:
                        await output_queue.put(line)

                    run_task = asyncio.create_task(
                        _run_streaming_dbt_command(
                            cmd,
                            project_path,
                            project_id=project_id,
                            env=dbt_env,
                            max_line_bytes=MAX_LINE_BYTES,
                            on_line=enqueue_output,
                        )
                    )

                    async def mark_done() -> None:
                        try:
                            await asyncio.shield(run_task)
                        finally:
                            await output_queue.put(None)

                    done_task = asyncio.create_task(mark_done())
                    try:
                        while True:
                            decoded_line = await output_queue.get()
                            if decoded_line is None:
                                break
                            if len(decoded_line.encode()) > MAX_LINE_BYTES:
                                decoded_line = decoded_line[:MAX_LINE_BYTES] + "...[truncated]"
                            if log_chars < MAX_LOG_CHARS:
                                output_lines.append(decoded_line[: MAX_LOG_CHARS - log_chars])
                                log_chars += len(decoded_line)
                            output_event = {"type": "output", "line": decoded_line}
                            dbt_run_log_hub.publish(run_id, output_event)
                            yield f"data: {json.dumps(output_event)}\n\n"
                        returncode = await run_task
                    finally:
                        if not done_task.done():
                            done_task.cancel()
                            await asyncio.gather(done_task, return_exceptions=True)
                        if not run_task.done():
                            run_task.cancel()
                            await asyncio.gather(run_task, return_exceptions=True)

                    logger.info(
                        "[DBT-PERF] sse subprocess_stream project_id=%s run_id=%s returncode=%s elapsed_ms=%s cmd=%s",
                        project_id,
                        run_id,
                        returncode,
                        _elapsed_ms(subprocess_start),
                        " ".join(cmd),
                    )
                    if returncode == -1:
                        raise asyncio.CancelledError()
            status = "success" if returncode == 0 else "error"
            error_message = None if returncode == 0 else "\n".join(output_lines)
            if returncode == 0 and command_name == "deps":
                DbtService._invalidate_partial_parse_cache(project_path)

            phase_start = time.perf_counter()
            await persistence.persist_complete(status, error_message)
            logger.info(
                "[DBT-PERF] sse persist_complete project_id=%s run_id=%s status=%s elapsed_ms=%s",
                project_id,
                run_id,
                status,
                _elapsed_ms(phase_start),
            )
            logger.info(
                "[DBT-PERF] sse total project_id=%s run_id=%s elapsed_ms=%s",
                project_id,
                run_id,
                _elapsed_ms(total_start),
            )
            completed_event = {"type": "completed", "returncode": returncode}
            dbt_run_log_hub.publish(run_id, completed_event)
            yield f"data: {json.dumps(completed_event)}\n\n"

        except asyncio.CancelledError:
            await asyncio.shield(
                persistence.persist_complete("cancelled", "Command cancelled by user")
            )
            dbt_run_log_hub.publish(
                run_id, {"type": "completed", "returncode": -1, "status": "cancelled"}
            )
            raise
        except Exception as e:
            logger.error(f"[dbt_sse] Error: {e}")
            await persistence.persist_complete("error", str(e))
            error_event = {"type": "error", "error": str(e)}
            dbt_run_log_hub.publish(run_id, error_event)
            yield f"data: {json.dumps(error_event)}\n\n"
    return StreamingResponse(
        stream_dbt(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
