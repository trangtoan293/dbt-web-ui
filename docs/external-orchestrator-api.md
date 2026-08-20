# External Orchestrator API

This contract is for Airflow or any external orchestrator that needs to trigger
application runs, poll state, collect logs/artifacts, and cancel work.

**Base URL:** dbt-runner, for example `http://dbt-runner:8080`

**Auth:** every endpoint below requires a bearer access token from the
configured OIDC issuer:

```http
Authorization: Bearer <access_token>
```

The token is resolved to an application user and every run is scoped through
project ownership. Unauthorized or cross-user project/run access returns `404`
or `401`.

## Recommended Flow

1. `POST /dbt/runs` to start a dbt command asynchronously.
2. Poll `GET /dbt/runs/{run_id}` until `status` is terminal.
3. Fetch `GET /dbt/runs/{run_id}/logs` for persisted logs.
4. Fetch `GET /dbt/runs/{run_id}/artifacts` when per-model details are needed.
5. Call `POST /dbt/runs/{run_id}/cancel` from the orchestrator kill handler.

Terminal statuses:

- `success`
- `error`
- `cancelled`

Non-terminal statuses:

- `running`
- `pending` (reserved for queued/future use)

## Start Async dbt Run

### `POST /dbt/runs`

Starts a dbt command and returns immediately with a `run_id`.

Request:

```json
{
  "project_id": "6b4c6f8e-7949-4b7b-9b75-9f8f6f8277f1",
  "command": "build",
  "selector": "tag:nightly",
  "flags": ["--full-refresh"],
  "environment_variables": {
    "DBT_ENV_CUSTOM_ENV_AIRFLOW_DAG_ID": "daily_dbt"
  }
}
```

Response `202`:

```json
{
  "id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
  "run_id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
  "project_id": "6b4c6f8e-7949-4b7b-9b75-9f8f6f8277f1",
  "status": "running",
  "started_at": "2026-07-01T12:00:00+00:00"
}
```

Notes:

- `command` may be a single dbt command (`run`, `test`, `build`) or a command
  string (`build --select tag:nightly`).
- `selector` is appended as `--select <selector>` by the runner.
- `flags` are appended after the command/selector.
- Client-provided `--profiles-dir` is stripped; the service always uses the
  server-side project profile.
- The runner serializes dbt work per project via its existing project lock and
  global dbt semaphore.

## Get Run

### `GET /dbt/runs/{run_id}`

Returns status, timings, summary counts, logs, and `run_results.json` content.

Query params:

- `include_logs=true|false`, default `true`

Response:

```json
{
  "id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
  "project_id": "6b4c6f8e-7949-4b7b-9b75-9f8f6f8277f1",
  "command": "build",
  "selector": "tag:nightly",
  "status": "success",
  "started_at": "2026-07-01T12:00:00+00:00",
  "completed_at": "2026-07-01T12:03:24+00:00",
  "duration_ms": 204000,
  "models_total": 42,
  "models_success": 42,
  "models_error": 0,
  "error_message": null,
  "results": {},
  "git_commit": "0123456789abcdef0123456789abcdef01234567",
  "created_at": "2026-07-01T12:00:00+00:00",
  "logs": "dbt output..."
}
```

Polling guidance:

- Poll every 5-15 seconds for long runs.
- Stop polling when `status` is `success`, `error`, or `cancelled`.
- Use `include_logs=false` while polling if logs are large, then call the logs
  endpoint once the run is terminal.

## List Runs

### `GET /dbt/runs`

Lists run history visible to the authenticated user.

Query params:

- `project_id=<uuid>` or `projectId=<uuid>`
- `status=running|success|error|cancelled`
- `limit=1..200`, default `50`
- `offset=0..`, default `0`
- `include_logs=true|false`, default `false`

Response:

```json
[
  {
    "id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
    "project_id": "6b4c6f8e-7949-4b7b-9b75-9f8f6f8277f1",
    "command": "build",
    "selector": "tag:nightly",
    "status": "success",
    "started_at": "2026-07-01T12:00:00+00:00",
    "completed_at": "2026-07-01T12:03:24+00:00",
    "duration_ms": 204000,
    "models_total": 42,
    "models_success": 42,
    "models_error": 0,
    "error_message": null,
    "results": {},
    "git_commit": "0123456789abcdef0123456789abcdef01234567",
    "created_at": "2026-07-01T12:00:00+00:00"
  }
]
```

## Get Logs

### `GET /dbt/runs/{run_id}/logs`

Returns persisted logs. This is the REST fallback for orchestrators that do not
want to keep an SSE connection open.

Query params:

- `offset=0..`, default `0`
- `limit=1..1048576`, default `65536`

Response:

```json
{
  "run_id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
  "offset": 0,
  "next_offset": 65536,
  "has_more": true,
  "logs": "dbt output chunk..."
}
```

## Get Artifacts

### `GET /dbt/runs/{run_id}/artifacts`

Returns per-model artifacts captured from dbt `run_results.json`.

Response:

```json
[
  {
    "id": "7af1a6d4-5af8-42b0-a192-a8f62afc95df",
    "run_id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
    "model_id": null,
    "unique_id": "model.analytics.orders",
    "status": "success",
    "execution_time": 1.23,
    "compiled_code": "select ...",
    "error": null,
    "timing": [],
    "created_at": "2026-07-01T12:03:24+00:00"
  }
]
```

## Cancel Run

### `POST /dbt/runs/{run_id}/cancel`

Requests cancellation for a running dbt run.

Response:

```json
{
  "success": true,
  "run_id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
  "project_id": "6b4c6f8e-7949-4b7b-9b75-9f8f6f8277f1",
  "message": "Cancellation requested"
}
```

If the run is already terminal, the endpoint returns `409`:

```json
{
  "success": false,
  "run_id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
  "status": "success",
  "message": "Run is already terminal"
}
```

## Synchronous dbt Command

### `POST /dbt/command`

Runs a dbt command synchronously and returns stdout/stderr after completion.
This is still useful for short commands, but external orchestrators should
prefer `POST /dbt/runs` so task workers are not tied to a long HTTP request.

## Streaming dbt Run

### `POST /sse/dbt/{project_id}`

Streams dbt output as Server-Sent Events. The first event includes `run_id`:

```json
{
  "type": "started",
  "run_id": "2f4b4f2e-6e1a-4fa7-99a8-7c7a9c0d2ec2",
  "project_id": "6b4c6f8e-7949-4b7b-9b75-9f8f6f8277f1",
  "command": "dbt build --select tag:nightly --profiles-dir /workspace/project",
  "status": "running"
}
```

Follow-up event replay:

### `GET /sse/dbt-runs/{run_id}/events`

Streams live/replayed events for a known dbt run.

## Health Checks

Use these before submitting work:

- `GET /health`
- `GET /ready`
- `GET /metrics`

## Airflow Task Sketch

```python
import time
import requests


def run_dbt_studio(base_url, token, project_id):
    headers = {"Authorization": f"Bearer {token}"}
    start = requests.post(
        f"{base_url}/dbt/runs",
        headers=headers,
        json={"project_id": project_id, "command": "build"},
        timeout=30,
    )
    start.raise_for_status()
    run_id = start.json()["run_id"]

    while True:
        res = requests.get(
            f"{base_url}/dbt/runs/{run_id}",
            headers=headers,
            params={"include_logs": "false"},
            timeout=30,
        )
        res.raise_for_status()
        run = res.json()
        if run["status"] in {"success", "error", "cancelled"}:
            break
        time.sleep(10)

    logs = requests.get(
        f"{base_url}/dbt/runs/{run_id}/logs",
        headers=headers,
        timeout=30,
    ).json()["logs"]

    if run["status"] != "success":
        raise RuntimeError(f"run {run_id} ended as {run['status']}\n{logs}")

    return run_id
```
