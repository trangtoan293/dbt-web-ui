"""Warm dbt worker pool for low-latency parse/compile-style commands."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.config import settings

logger = logging.getLogger(__name__)


def _elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


class DbtWarmWorkerError(RuntimeError):
    """Raised when a warm worker cannot complete a dbt job."""


class DbtWarmWorker:
    def __init__(self, worker_id: int, project_id: str) -> None:
        self.worker_id = worker_id
        self.project_id = project_id
        self.process: asyncio.subprocess.Process | None = None
        self.stderr_task: asyncio.Task | None = None
        self.jobs_completed = 0

    async def start(self) -> None:
        if self.process and self.process.returncode is None:
            return

        start = time.perf_counter()
        self.process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "app.services.dbt_worker_process",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # dbt show --output json emits the whole result as one line; the
            # asyncio StreamReader default limit (64 KiB) overflows on wide/large
            # previews and raises LimitOverrunError. Raise the per-line buffer.
            limit=settings.dbt_warm_worker_stream_limit,
            env=os.environ.copy(),
        )
        self.stderr_task = asyncio.create_task(self._drain_stderr())
        if not self.process.stdout:
            raise DbtWarmWorkerError(f"worker {self.worker_id} stdout unavailable")
        ready_line = await asyncio.wait_for(
            self.process.stdout.readline(),
            timeout=settings.dbt_warm_worker_timeout,
        )
        if not ready_line:
            raise DbtWarmWorkerError(f"worker {self.worker_id} failed to start")
        ready = json.loads(ready_line.decode())
        if ready.get("type") != "ready":
            raise DbtWarmWorkerError(f"worker {self.worker_id} invalid ready response")
        logger.info(
            "[DBT-PERF] warm_worker start worker_id=%s elapsed_ms=%s",
            self.worker_name,
            _elapsed_ms(start),
        )

    async def stop(self) -> None:
        process = self.process
        if not process or process.returncode is not None:
            return

        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

        if self.stderr_task:
            self.stderr_task.cancel()

    async def _drain_stderr(self) -> None:
        process = self.process
        if not process or not process.stderr:
            return

        while True:
            line = await process.stderr.readline()
            if not line:
                break
            logger.warning(
                "[DBT-WORKER-%s] %s",
                self.worker_name,
                line.decode(errors="replace").rstrip(),
            )

    async def run(
        self,
        args: List[str],
        cwd: Path,
        env: Optional[Dict[str, str]] = None,
    ) -> Tuple[int, str, str]:
        await self.start()
        assert self.process is not None
        if self.process.returncode is not None:
            raise DbtWarmWorkerError(f"worker {self.worker_id} exited")
        if not self.process.stdin or not self.process.stdout:
            raise DbtWarmWorkerError(f"worker {self.worker_id} pipes unavailable")

        request_id = str(uuid.uuid4())
        payload = {
            "id": request_id,
            "project_id": self.project_id,
            "args": args,
            "cwd": str(cwd),
            "env": env or {},
        }
        self.process.stdin.write((json.dumps(payload) + "\n").encode())
        await self.process.stdin.drain()

        leaked_stdout: list[str] = []
        deadline = time.monotonic() + settings.dbt_warm_worker_timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            try:
                line = await asyncio.wait_for(
                    self.process.stdout.readline(),
                    timeout=remaining,
                )
            except ValueError as exc:
                # StreamReader.readline() raises ValueError when a response line
                # exceeds the buffer limit. Surface as DbtWarmWorkerError so the
                # caller falls back to the communicate()-based subprocess path.
                raise DbtWarmWorkerError(
                    f"worker {self.worker_id} response exceeded stream limit"
                ) from exc
            if not line:
                raise DbtWarmWorkerError(f"worker {self.worker_id} closed stdout")

            decoded = line.decode(errors="replace")
            try:
                response = json.loads(decoded)
            except json.JSONDecodeError:
                leaked_stdout.append(decoded)
                continue

            if response.get("id") == request_id:
                break
            leaked_stdout.append(decoded)

        self.jobs_completed += 1
        return (
            int(response.get("returncode", 1)),
            "".join(leaked_stdout) + str(response.get("stdout", "")),
            str(response.get("stderr", "")),
        )

    def should_recycle(self) -> bool:
        return self.jobs_completed >= settings.dbt_warm_worker_recycle_jobs

    @property
    def worker_name(self) -> str:
        return f"{self.project_id}:{self.worker_id}"


class _ProjectWorkerPool:
    def __init__(self, project_id: str, worker_count: int) -> None:
        self.project_id = project_id
        self.worker_count = worker_count
        self._workers: list[DbtWarmWorker] = []
        self._available: asyncio.Queue[DbtWarmWorker] = asyncio.Queue()
        self._start_lock = asyncio.Lock()
        self._started = False

    async def start(self) -> None:
        async with self._start_lock:
            if self._started:
                return
            for index in range(self.worker_count):
                worker = DbtWarmWorker(index + 1, self.project_id)
                await worker.start()
                self._workers.append(worker)
                await self._available.put(worker)
            self._started = True
            logger.info(
                "Started project-scoped dbt warm workers project_id=%s workers=%s",
                self.project_id,
                self.worker_count,
            )

    async def stop(self) -> None:
        for worker in self._workers:
            await worker.stop()
        self._workers.clear()
        self._started = False

    async def get(self) -> DbtWarmWorker:
        await self.start()
        try:
            return await asyncio.wait_for(
                self._available.get(),
                timeout=settings.file_lock_wait_timeout,
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"dbt warm worker queue is full for project {self.project_id}"
            ) from exc

    async def put(self, worker: DbtWarmWorker, *, recycle: bool = False) -> None:
        if recycle:
            await worker.stop()
            await worker.start()
            worker.jobs_completed = 0
        await self._available.put(worker)


class DbtWarmWorkerPool:
    def __init__(self) -> None:
        self.enabled = settings.dbt_warm_worker_enabled
        self.worker_count = max(0, settings.dbt_warm_worker_count)
        self.capacity = max(1, self.worker_count + settings.dbt_warm_worker_queue_size)
        self._project_pools: Dict[str, _ProjectWorkerPool] = {}
        self._capacity_sem = asyncio.BoundedSemaphore(self.capacity)
        self._started = False
        self._start_lock = asyncio.Lock()

    async def start(self) -> None:
        if not self.enabled or self.worker_count <= 0:
            return

        async with self._start_lock:
            if self._started:
                return
            self._started = True
            logger.info(
                "Started project-scoped dbt warm worker pool workers_per_project=%s queue_size=%s",
                self.worker_count,
                settings.dbt_warm_worker_queue_size,
            )

    async def stop(self) -> None:
        for pool in self._project_pools.values():
            await pool.stop()
        self._project_pools.clear()
        self._started = False

    def _pool_for_project(self, project_id: str) -> _ProjectWorkerPool:
        pool = self._project_pools.get(project_id)
        if pool is None:
            pool = _ProjectWorkerPool(project_id, self.worker_count)
            self._project_pools[project_id] = pool
        return pool

    async def run(
        self,
        args: List[str],
        cwd: Path,
        *,
        project_id: str,
        env: Optional[Dict[str, str]] = None,
    ) -> Tuple[int, str, str, int]:
        if not self.enabled or self.worker_count <= 0:
            raise DbtWarmWorkerError("warm worker pool disabled")

        await self.start()
        queue_start = time.perf_counter()
        try:
            await asyncio.wait_for(
                self._capacity_sem.acquire(),
                timeout=settings.file_lock_wait_timeout,
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError("dbt warm worker queue is full") from exc

        project_pool = self._pool_for_project(project_id)
        worker: DbtWarmWorker | None = None
        try:
            worker = await project_pool.get()
            queue_wait_ms = _elapsed_ms(queue_start)
            exec_start = time.perf_counter()
            worker_failed = False
            try:
                returncode, stdout, stderr = await worker.run(args, cwd, env)
                logger.info(
                    "[DBT-PERF] warm_worker execute worker_id=%s project_id=%s returncode=%s queue_wait_ms=%s elapsed_ms=%s args=%s",
                    worker.worker_name,
                    project_id,
                    returncode,
                    queue_wait_ms,
                    _elapsed_ms(exec_start),
                    " ".join(args),
                )
                return returncode, stdout, stderr, queue_wait_ms
            except BaseException:
                worker_failed = True
                await worker.stop()
                raise
            finally:
                await project_pool.put(
                    worker,
                    recycle=worker_failed or worker.should_recycle(),
                )
        finally:
            self._capacity_sem.release()


warm_worker_pool = DbtWarmWorkerPool()
