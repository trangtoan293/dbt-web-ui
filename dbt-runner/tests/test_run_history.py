import asyncio
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("STORAGE_DIR", "/tmp/dbt-craft-test-storage")

from app.routers.sse import _SseRunPersistence, _run_streaming_dbt_command
from app.main import _reconcile_stale_runs_once
from app.models.dbt import CompileRequest, DbtCommand, PreviewRequest
from app.services.command import CommandService
from app.services.dbt_service import DbtService
from app.services.dbt_worker import DbtWarmWorker, DbtWarmWorkerPool


class _SessionContext:
    def __init__(self, session):
        self.session = session

    async def __aenter__(self):
        return self.session

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class _StaticProjectService:
    def __init__(self, project_path):
        self.project_path = project_path

    def get_path_or_raise(self, project_id):
        return self.project_path


class DbtDepsCacheTests(unittest.IsolatedAsyncioTestCase):
    def test_invalidate_partial_parse_cache_removes_cache_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            cache_path = project_path / "target" / "partial_parse.msgpack"
            cache_path.parent.mkdir()
            cache_path.write_bytes(b"stale-cache")

            DbtService._invalidate_partial_parse_cache(project_path)

            self.assertFalse(cache_path.exists())

    async def test_successful_deps_invalidates_partial_parse_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            cache_path = project_path / "target" / "partial_parse.msgpack"
            cache_path.parent.mkdir()
            cache_path.write_bytes(b"stale-cache")

            service = DbtService(project_service=_StaticProjectService(project_path))

            with (
                patch("app.services.dbt_service.global_run_semaphore", return_value=_SessionContext(None)),
                patch("app.services.dbt_service.AsyncFileLock.lock", return_value=_SessionContext(None)),
                patch.object(service, "_run_dbt_command", AsyncMock(return_value=(0, "deps ok", ""))),
            ):
                result = await service.run_command(
                    DbtCommand(project_id="project-id", command="deps")
                )

            self.assertTrue(result["success"])
            self.assertFalse(cache_path.exists())


class DbtSseStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_streaming_command_emits_first_line_before_process_exits(self):
        lines = []
        first_line = asyncio.Event()

        async def on_line(line: str):
            lines.append(line)
            if line == "first":
                first_line.set()

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("app.routers.sse.CommandService._register_process", AsyncMock()),
            patch("app.routers.sse.CommandService._unregister_process", AsyncMock()),
            patch("app.routers.sse.CommandService._is_cancelled", AsyncMock(return_value=False)),
        ):
            task = asyncio.create_task(
                _run_streaming_dbt_command(
                    [
                        sys.executable,
                        "-c",
                        "import time; print('first', flush=True); time.sleep(0.2); print('second', flush=True)",
                    ],
                    Path(tmp),
                    project_id="project-id",
                    env=None,
                    max_line_bytes=64 * 1024,
                    on_line=on_line,
                )
            )
            await asyncio.wait_for(first_line.wait(), timeout=1)
            self.assertFalse(task.done())
            returncode = await task

        self.assertEqual(returncode, 0)
        self.assertEqual(lines, ["first", "second"])


class DbtHeaderCommandEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_compile_model_passes_client_environment_variables_to_dbt(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            service = DbtService(project_service=_StaticProjectService(project_path))
            run_dbt = AsyncMock(return_value=(1, "", "compile failed"))

            with (
                patch("app.services.dbt_service.AsyncFileLock.lock", return_value=_SessionContext(None)),
                patch.object(service, "_run_dbt_command", run_dbt),
            ):
                result = await service.compile_model(
                    CompileRequest(
                        project_id="project-id",
                        model_path="models/orders.sql",
                        environment_variables={"DBT_ENV_CUSTOM_ENV_KTL_BRANCH": "dev"},
                    )
                )

            self.assertFalse(result["success"])
            self.assertEqual(
                run_dbt.await_args.kwargs["env"],
                {"DBT_ENV_CUSTOM_ENV_KTL_BRANCH": "dev"},
            )
            cmd = run_dbt.await_args.args[0]
            self.assertIn("--profiles-dir", cmd)
            self.assertIn(str(project_path), cmd)

    async def test_inline_query_worker_timeout_does_not_fallback_to_subprocess(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            worker_pool = AsyncMock()
            worker_pool.run.side_effect = asyncio.TimeoutError()
            command = AsyncMock()
            command.run_cancellable = AsyncMock(return_value=(0, "unexpected", ""))
            service = DbtService(
                command_service=command,
                project_service=_StaticProjectService(project_path),
                worker_pool=worker_pool,
            )

            returncode, stdout, stderr = await service._run_dbt_command(
                ["dbt", "show", "--inline", "select 1"],
                project_path,
                project_id="project-id",
                fallback_process_id="project-id:query",
                cancellable=True,
                timeout=0.01,
                fallback_on_worker_timeout=False,
            )

            self.assertEqual(returncode, -1)
            self.assertEqual(stdout, "")
            self.assertIn("timed out", stderr)
            command.run_cancellable.assert_not_awaited()


class CommandServiceTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_cancellable_kills_process_on_timeout(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(CommandService, "_register_process", AsyncMock()),
            patch.object(CommandService, "_unregister_process", AsyncMock()),
            patch.object(CommandService, "_is_cancelled", AsyncMock(return_value=False)),
        ):
            returncode, stdout, stderr = await CommandService.run_cancellable(
                [
                    sys.executable,
                    "-c",
                    "import time; print('started', flush=True); time.sleep(10)",
                ],
                Path(tmp),
                "timeout-test",
                timeout=0.1,
            )

        self.assertEqual(returncode, -1)
        self.assertIsInstance(stdout, str)
        self.assertIn("timed out", stderr)

    async def test_preview_model_passes_client_environment_variables_to_dbt(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            service = DbtService(project_service=_StaticProjectService(project_path))
            run_dbt = AsyncMock(return_value=(1, "", "preview failed"))

            with (
                patch("app.services.dbt_service.AsyncFileLock.lock", return_value=_SessionContext(None)),
                patch.object(service, "_run_dbt_command", run_dbt),
            ):
                result = await service.preview_model(
                    PreviewRequest(
                        project_id="project-id",
                        model_path="models/orders.sql",
                        environment_variables={"DBT_ENV_CUSTOM_ENV_KTL_BRANCH": "dev"},
                    )
                )

            self.assertFalse(result["success"])
            self.assertEqual(
                run_dbt.await_args.kwargs["env"],
                {"DBT_ENV_CUSTOM_ENV_KTL_BRANCH": "dev"},
            )
            cmd = run_dbt.await_args.args[0]
            self.assertIn("--profiles-dir", cmd)
            self.assertIn(str(project_path), cmd)
            self.assertIn("--indirect-selection", cmd)
            self.assertEqual(cmd[cmd.index("--indirect-selection") + 1], "empty")


class DbtExplainSyntaxTests(unittest.TestCase):
    def test_load_dremio_profile_config_resolves_env_secret(self):
        with tempfile.TemporaryDirectory() as tmp:
            project_path = Path(tmp)
            (project_path / "dbt_project.yml").write_text("name: ktl_dbt\nprofile: ktl_dbt\n")
            (project_path / "profiles.yml").write_text(
                """
ktl_dbt:
  outputs:
    dev:
      type: dremio
      software_host: dremio.example.com
      port: 9047
      user: "vaultadmin"
      password: "{{ env_var('DBT_ENV_SECRET_DBT_CRAFT_CREDENTIAL') }}"
      use_ssl: false
  target: dev
""".strip()
            )

            config = DbtService._load_dremio_profile_config(
                project_path,
                {"DBT_ENV_SECRET_DBT_CRAFT_CREDENTIAL": "secret-password"},
            )

        self.assertIsNotNone(config)
        self.assertEqual(config["software_host"], "dremio.example.com")
        self.assertEqual(config["password"], "secret-password")

    def test_dremio_explain_uses_explain_plan_for_with_queries(self):
        sql = "with orders as (select * from raw.orders) select * from orders"

        self.assertEqual(
            DbtService._build_explain_sql("dremio", sql),
            "EXPLAIN PLAN FOR with orders as (select * from raw.orders) select * from orders",
        )

    def test_default_explain_keeps_postgres_duckdb_syntax(self):
        sql = "with orders as (select * from raw.orders) select * from orders"

        self.assertEqual(
            DbtService._build_explain_sql("postgres", sql),
            "EXPLAIN with orders as (select * from raw.orders) select * from orders",
        )

    def test_inline_query_allowlist_accepts_estimated_dremio_explain(self):
        self.assertTrue(
            DbtService._is_allowed_inline_sql(
                "EXPLAIN PLAN FOR with orders as (select * from raw.orders) select * from orders"
            )
        )

    def test_inline_query_allowlist_rejects_explain_analyze(self):
        self.assertFalse(
            DbtService._is_allowed_inline_sql(
                "EXPLAIN ANALYZE select * from raw.orders"
            )
        )


class ProjectScopedWarmWorkerPoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_warm_workers_are_reused_only_within_the_same_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            starts = []
            runs = []

            async def fake_start(worker):
                starts.append((worker.project_id, worker.worker_id))

            async def fake_stop(worker):
                return None

            async def fake_run(worker, args, cwd, env=None):
                runs.append((worker.project_id, worker.worker_id, tuple(args), cwd))
                return 0, f"ok {worker.project_id}", ""

            pool = DbtWarmWorkerPool()
            pool.enabled = True
            pool.worker_count = 1

            with (
                patch.object(DbtWarmWorker, "start", fake_start),
                patch.object(DbtWarmWorker, "stop", fake_stop),
                patch.object(DbtWarmWorker, "run", fake_run),
            ):
                await pool.run(["compile"], Path(tmp) / "a", project_id="project-a")
                await pool.run(["compile"], Path(tmp) / "b", project_id="project-b")
                await pool.run(["parse"], Path(tmp) / "a", project_id="project-a")
                await pool.stop()

            self.assertEqual(starts, [("project-a", 1), ("project-b", 1)])
            self.assertEqual(
                [run[0] for run in runs],
                ["project-a", "project-b", "project-a"],
            )
            self.assertEqual(set(pool._project_pools.keys()), set())


class SseRunPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_update_can_be_retried(self):
        session = object()
        persistence = _SseRunPersistence(
            run_id="run-id",
            started_at=datetime.now(timezone.utc),
            run_results_path=Path("/tmp/run_results.json"),
            run_results_mtime_before=None,
            project_path=Path("/tmp/project"),
            output_lines=["first line", "second line"],
        )
        update_run = AsyncMock(side_effect=[RuntimeError("database unavailable"), None])

        with (
            patch("app.routers.sse.async_session", return_value=_SessionContext(session)),
            patch.object(DbtService, "_read_run_results", return_value=None),
            patch.object(DbtService, "_get_dbt_counts", return_value=(0, 0, 0)),
            patch.object(DbtService, "_update_run_complete", update_run),
        ):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                await persistence.persist_complete("success")

            self.assertFalse(persistence.persisted)
            await persistence.persist_complete("success")
            await persistence.persist_complete("success")

        self.assertTrue(persistence.persisted)
        self.assertEqual(update_run.await_count, 2)


class StaleRunReconciliationTests(unittest.IsolatedAsyncioTestCase):
    async def test_running_runs_are_marked_cancelled(self):
        result = unittest.mock.Mock()
        result.fetchall.return_value = [("run-1",), ("run-2",)]
        session = unittest.mock.Mock()
        session.execute = AsyncMock(return_value=result)
        session.commit = AsyncMock()

        reconciled = await DbtService.reconcile_stale_runs(session)

        self.assertEqual(reconciled, 2)
        session.commit.assert_awaited_once()
        query = str(session.execute.await_args.args[0])
        self.assertIn("WHERE status = 'running'", query)
        self.assertIn("status = 'cancelled'", query)

    async def test_startup_reconciliation_runs_once_per_runner_launch(self):
        session = object()
        reconcile = AsyncMock(return_value=2)

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("app.main.async_session", return_value=_SessionContext(session)),
            patch.object(DbtService, "reconcile_stale_runs", reconcile),
        ):
            first = await _reconcile_stale_runs_once(Path(tmp), "launch-1")
            second = await _reconcile_stale_runs_once(Path(tmp), "launch-1")

        self.assertEqual(first, 2)
        self.assertIsNone(second)
        reconcile.assert_awaited_once_with(session)

    async def test_new_runner_launch_ignores_previous_launch_marker(self):
        session = object()
        reconcile = AsyncMock(return_value=1)

        with (
            tempfile.TemporaryDirectory() as tmp,
            patch("app.main.async_session", return_value=_SessionContext(session)),
            patch.object(DbtService, "reconcile_stale_runs", reconcile),
        ):
            first = await _reconcile_stale_runs_once(Path(tmp), "launch-1")
            after_restart = await _reconcile_stale_runs_once(Path(tmp), "launch-2")

        self.assertEqual(first, 1)
        self.assertEqual(after_restart, 1)
        self.assertEqual(reconcile.await_count, 2)


if __name__ == "__main__":
    unittest.main()
