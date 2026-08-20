"""Long-lived dbt worker process.

The parent process sends one JSON object per line on stdin:
{"id": "...", "args": ["compile", ...], "cwd": "...", "env": {...}}

The worker responds with one JSON object per line on stdout. dbt stdout/stderr is
captured inside the response so protocol stdout stays machine-readable.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback
from typing import Any

from dbt.cli.main import dbtRunner


def _run_dbt(args: list[str], cwd: str, env: dict[str, str]) -> dict[str, Any]:
    old_cwd = os.getcwd()
    old_env: dict[str, str | None] = {key: os.environ.get(key) for key in env}
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()

    try:
        os.chdir(cwd)
        os.environ.update(env)
        runner = dbtRunner()
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            result = runner.invoke(args)

        exception = getattr(result, "exception", None)
        return {
            "returncode": 0 if getattr(result, "success", False) else 1,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue()
            + (f"\n{exception}" if exception else ""),
        }
    except BaseException:
        return {
            "returncode": 1,
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue() + traceback.format_exc(),
        }
    finally:
        os.chdir(old_cwd)
        for key, value in old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main() -> int:
    sys.stdout.write(json.dumps({"type": "ready"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        try:
            payload = json.loads(line)
            result = _run_dbt(
                args=list(payload["args"]),
                cwd=str(payload["cwd"]),
                env={str(k): str(v) for k, v in (payload.get("env") or {}).items()},
            )
            result["id"] = payload.get("id")
        except BaseException:
            result = {
                "id": None,
                "returncode": 1,
                "stdout": "",
                "stderr": traceback.format_exc(),
            }

        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
