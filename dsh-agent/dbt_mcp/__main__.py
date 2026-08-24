"""MCP server exposing this project's dbt actions to the agent.

The agent already edits files directly (the harness `fs` tools, fenced to the
project directory by the sandbox). What it must NOT do directly is run dbt:
DuckDB is single-writer, a warm worker holds the project's database file, and
per-run memory is derived from `MAX_CONCURRENT_DBT_RUNS`. So every execution
goes back through dbt-runner's own endpoints and inherits its locks, its run
semaphore and its ownership checks.

Credentials: the bearer is read from DBT_RUNNER_TOKEN_FILE on every call, not
from the environment, because this process is spawned once per session while the
token expires during it.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import httpx
from mcp.server import MCPServer

RUNNER = os.environ.get("DBT_RUNNER_URL", "http://dbt-runner:8080").rstrip("/")
PROJECT_ID = os.environ["DBT_PROJECT_ID"]
TOKEN_FILE = os.environ.get("DBT_RUNNER_TOKEN_FILE")
# A dbt run is minutes, not seconds; the harness side raises its own tool
# timeout to match (see the profile's cordis.patch.yml).
READY_FILE = os.environ.get("DBT_MCP_READY_FILE")
RUN_POLL_SECONDS = 3
RUN_TIMEOUT_SECONDS = int(os.environ.get("DBT_MCP_RUN_TIMEOUT", "1800"))
LOG_TAIL_CHARS = 4000

class ReadyAnnouncingServer(MCPServer):
    """Touch a file once the harness has discovered these tools.

    The harness's JSON-RPC server starts answering before its MCP client has
    finished discovery, so a prompt sent immediately after `initialize` can be
    assembled without any dbt tools. `tools/list` is the discovery call, so
    serving it is the exact moment dsh-agent may let a prompt through.
    """

    async def list_tools(self):
        tools = await super().list_tools()
        if READY_FILE:
            try:
                Path(READY_FILE).write_text(str(len(tools)))
            except OSError:
                pass
        return tools


mcp = ReadyAnnouncingServer("dbt")


def _headers() -> dict[str, str]:
    if not TOKEN_FILE:
        return {}
    try:
        token = Path(TOKEN_FILE).read_text().strip()
    except OSError:
        return {}
    return {"Authorization": token} if token else {}


async def _call(method: str, path: str, **kwargs: Any) -> Any:
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.request(
            method, f"{RUNNER}{path}", headers=_headers(), **kwargs
        )
    if response.status_code >= 400:
        # Return the failure as data: the model can act on "model not found"
        # but not on a transport exception it cannot see.
        return {"error": f"dbt-runner returned {response.status_code}", "body": response.text[:600]}
    return response.json()


@mcp.tool()
async def list_models() -> Any:
    """List this project's dbt models, sources and macros with their columns."""
    data = await _call("GET", f"/dbt/intellisense/{PROJECT_ID}")
    if isinstance(data, dict) and "error" not in data:
        # The full catalog is large and mostly column detail the model did not
        # ask for; keep names and descriptions.
        return {
            "models": [
                {"name": m.get("name"), "description": m.get("description")}
                for m in data.get("models", [])
            ],
            "sources": [s.get("name") for s in data.get("sources", [])],
            "catalog_available": data.get("catalog_available"),
        }
    return data


@mcp.tool()
async def compile_model(model_path: str) -> Any:
    """Compile one model file and return its rendered SQL.

    model_path is relative to the project root, e.g. models/marts/orders.sql.
    """
    return await _call(
        "POST", "/dbt/compile", json={"project_id": PROJECT_ID, "model_path": model_path}
    )


@mcp.tool()
async def query(sql: str, limit: int = 100) -> Any:
    """Run one read-only SELECT against this project's warehouse."""
    return await _call(
        "POST",
        "/dbt/query",
        json={"project_id": PROJECT_ID, "sql": sql, "limit": min(max(limit, 1), 1000)},
    )


@mcp.tool()
async def run_dbt(command: str = "run", selector: str | None = None) -> Any:
    """Run dbt and wait for it to finish. Returns status, counts and log tail.

    command is one of run, build, test, seed, snapshot, compile. selector is a
    dbt --select expression; omit it to run everything, which on a large project
    is slow — prefer selecting the models you changed.
    """
    allowed = {"run", "build", "test", "seed", "snapshot", "compile"}
    if command not in allowed:
        return {"error": f"command must be one of {sorted(allowed)}"}

    started = await _call(
        "POST",
        "/dbt/runs",
        json={"project_id": PROJECT_ID, "command": command, "selector": selector},
    )
    if not isinstance(started, dict) or "error" in started:
        return started
    run_id = started.get("run_id") or started.get("id")
    if not run_id:
        return {"error": "dbt-runner did not return a run id", "response": started}

    waited = 0
    while waited < RUN_TIMEOUT_SECONDS:
        await asyncio.sleep(RUN_POLL_SECONDS)
        waited += RUN_POLL_SECONDS
        run = await _call("GET", f"/dbt/runs/{run_id}")
        if not isinstance(run, dict) or "error" in run:
            return run
        if run.get("status") != "running":
            logs = run.get("logs") or ""
            return {
                "run_id": run_id,
                "status": run.get("status"),
                "models_total": run.get("models_total"),
                "models_success": run.get("models_success"),
                "models_error": run.get("models_error"),
                "error_message": run.get("error_message"),
                "logs_tail": logs[-LOG_TAIL_CHARS:],
            }
    return {"run_id": run_id, "status": "timeout", "waited_seconds": waited}


if __name__ == "__main__":
    mcp.run("stdio")
