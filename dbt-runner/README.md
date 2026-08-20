# dbt-runner API Reference

**FastAPI backend for this browser-based dbt development environment**

## Overview

dbt-runner is a Python FastAPI service that provides:
- dbt command execution (run, test, compile, docs) with SSE log streaming
- File operations (read, write, create, delete, search)
- Git version control operations
- Project and warehouse-connection management

**Base URL:** `http://localhost:8080`

This file covers the endpoints most often called by hand. The complete, always
current contract is the generated OpenAPI schema at `/docs` — prefer it when the
two disagree. For triggering runs from Airflow, see
[external-orchestrator-api.md](../docs/external-orchestrator-api.md).

---

## 📋 Table of Contents

- [Health Check](#health-check)
- [dbt Commands](#dbt-commands)
- [dbt Docs](#dbt-docs)
- [File Operations](#file-operations)
- [Git Operations](#git-operations)
- [Error Responses](#error-responses)

---

## Health Check

### GET `/health`

Check service health status.

**Response:**
```json
{
  "status": "healthy"
}
```

---

## dbt Commands

### POST `/dbt/command`

Execute a dbt command.

**Request Body:**
```json
{
  "project_id": "string",
  "command": "run | test | build | compile | seed | debug",
  "select": "optional model selector",
  "exclude": "optional exclusion",
  "full_refresh": false
}
```

**Response:**
```json
{
  "success": true,
  "output": "dbt command output...",
  "error": null
}
```

---

### POST `/dbt/compile`

Compile a specific dbt model and return rendered SQL.

**Request Body:**
```json
{
  "project_id": "string",
  "model_name": "customers"
}
```

**Response:**
```json
{
  "success": true,
  "compiled_sql": "SELECT * FROM ...",
  "error": null
}
```

---

### POST `/dbt/preview`

Preview model data (runs with LIMIT 100).

**Request Body:**
```json
{
  "project_id": "string",
  "model_name": "customers",
  "limit": 100
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {"customer_id": 1, "name": "John"},
    {"customer_id": 2, "name": "Jane"}
  ],
  "columns": ["customer_id", "name"],
  "row_count": 2
}
```

---

### POST `/dbt/lineage`

Get data lineage for a dbt project.

**Request Body:**
```json
{
  "project_id": "string",
  "model_name": "optional - focus on specific model"
}
```

**Response:**
```json
{
  "success": true,
  "nodes": [
    {"name": "stg_customers", "type": "model"},
    {"name": "customers", "type": "model"}
  ],
  "edges": [
    {"from": "stg_customers", "to": "customers"}
  ]
}
```

---

### POST `/dbt/init`

Initialize a new dbt project.

**Request Body:**
```json
{
  "project_id": "string",
  "project_name": "my_project",
  "adapter": "duckdb"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Project initialized",
  "path": "/tmp/dbt-projects/my_project"
}
```

---

## dbt Docs

### POST `/dbt/docs/generate`

Generate dbt documentation (catalog.json, manifest.json).

**Request Body:**
```json
{
  "project_id": "string"
}
```

---

### POST `/dbt/docs/serve`

Start dbt docs server as background process.

**Request Body:**
```json
{
  "project_id": "string",
  "port": 8081
}
```

---

### GET `/dbt/docs/status?project_id=xxx`

Get docs server status.

---

### GET `/dbt/docs/view/{project_id}`

View generated docs (returns HTML).

---

## File Operations

### GET `/files/{project_id}`

List files in a project directory.

**Query Parameters:**
- `path` (optional): Subdirectory path

**Response:**
```json
{
  "items": [
    {"name": "models", "type": "directory", "path": "models"},
    {"name": "dbt_project.yml", "type": "file", "path": "dbt_project.yml"}
  ]
}
```

---

### GET `/files/{project_id}/content?path=models/customers.sql`

Read file content.

**Response:**
```json
{
  "content": "SELECT * FROM ...",
  "path": "models/customers.sql"
}
```

---

### POST `/files/{project_id}/content`

Save file content.

**Request Body:**
```json
{
  "path": "models/customers.sql",
  "content": "SELECT * FROM ..."
}
```

---

### POST `/files/{project_id}/create`

Create a new file or directory.

**Request Body:**
```json
{
  "path": "models/staging/stg_orders.sql",
  "file_type": "file | directory",
  "content": "-- new model"
}
```

---

### DELETE `/files/{project_id}?path=models/old_model.sql`

Delete a file or directory.

---

### PUT `/files/{project_id}/rename?old_path=a.sql&new_path=b.sql`

Rename a file or directory.

---

### GET `/files/{project_id}/search?query=customers`

Search for files matching a query.

---

## Git Operations

### GET `/git/status/{project_id}`

Get git status of the project.

**Response:**
```json
{
  "success": true,
  "clean": false,
  "changes": [
    {"status": "M", "path": "models/customers.sql"},
    {"status": "??", "path": "models/new_model.sql"}
  ]
}
```

**Status Codes:**
| Code | Meaning |
|------|---------|
| M | Modified |
| A | Added (staged) |
| D | Deleted |
| ?? | Untracked |
| UU | Unmerged |

---

### GET `/git/branches/{project_id}`

Get list of branches.

**Response:**
```json
{
  "success": true,
  "branches": [
    {"name": "main", "is_current": true, "is_remote": false},
    {"name": "develop", "is_current": false, "is_remote": false}
  ],
  "current": "main"
}
```

---

### GET `/git/log/{project_id}?limit=50`

Get commit history.

**Response:**
```json
{
  "success": true,
  "commits": [
    {
      "hash": "abc123",
      "author": "John Doe",
      "email": "john@example.com",
      "date": "2024-12-16 10:00:00",
      "message": "Add customers model"
    }
  ]
}
```

---

### POST `/git/clone`

Clone a Git repository.

**Request Body:**
```json
{
  "project_id": "string",
  "git_url": "https://github.com/user/repo.git",
  "branch": "main"
}
```

---

### POST `/git/commit`

Stage all changes and commit.

**Request Body:**
```json
{
  "project_id": "string",
  "message": "Add customers model"
}
```

---

### POST `/git/push`

Push commits to remote.

**Request Body:**
```json
{
  "project_id": "string",
  "remote": "origin",
  "branch": "main",
  "username": "optional",
  "token": "optional for private repos"
}
```

---

### POST `/git/pull`

Pull latest changes.

**Request Body:**
```json
{
  "project_id": "string",
  "branch": "main",
  "username": "optional",
  "token": "optional"
}
```

---

### POST `/git/checkout`

Checkout a branch.

**Request Body:**
```json
{
  "project_id": "string",
  "branch": "develop"
}
```

---

### GET `/git/diff/{project_id}?file_path=models/customers.sql`

Get diff of changes.

**Response:**
```json
{
  "success": true,
  "unstaged_diff": "- old line\n+ new line",
  "staged_diff": ""
}
```

---

### POST `/git/add`

Stage files for commit.

**Query Parameters:**
- `project_id`: Project identifier
- `files` (optional): List of files to stage. If empty, stages all.

---

### POST `/git/reset`

Unstage files or reset changes.

**Query Parameters:**
- `project_id`: Project identifier
- `files` (optional): List of files to unstage
- `hard` (boolean): If true, performs hard reset

---

### POST `/git/exec?project_id=xxx&command=show HEAD:file.sql`

Execute arbitrary git command.

**Response:**
```json
{
  "success": true,
  "stdout": "command output",
  "stderr": ""
}
```

---

## Error Responses

All endpoints return consistent error format:

**404 Not Found:**
```json
{
  "detail": "Project not found: project_id"
}
```

**400 Bad Request:**
```json
{
  "detail": "Invalid path: ../etc/passwd"
}
```

**500 Internal Server Error:**
```json
{
  "detail": "dbt command failed: error message"
}
```

---

## Running the Service

### Development

```bash
cd dbt-runner
uv sync --frozen --extra test
uv run uvicorn app.main:app --reload --port 8080
uv run pytest -q
```

Needs PostgreSQL and Redis reachable — `docker compose up -d postgres redis`
starts both.

### Docker

```bash
docker compose up dbt-runner
```

### Health Check

```bash
curl http://localhost:8080/health
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | required |
| `REDIS_URL` | Redis for run locks and the run semaphore | `redis://redis:6379/0` |
| `WORKSPACE_DIR` | Where dbt projects are checked out | `/tmp/dbt-projects` |
| `STORAGE_DIR` | Shared project storage volume | `/data/storage` |
| `APP_ENCRYPTION_KEY` | AES key for stored credentials | required |
| `AUTH_DISABLED` | `true` skips JWT verification (single-user) | `false` |
| `OIDC_ISSUER` | OIDC issuer; `jwks_uri` comes from its discovery document | — |
| `OIDC_JWKS_URI` | Explicit JWKS URL, only if discovery is unavailable | — |
| `OIDC_AUDIENCE` | Expected token audience | `dbt-craft` |
| `CORS_ORIGINS` | JSON array of allowed browser origins | localhost:3000 |
| `MAX_CONCURRENT_DBT_RUNS` | Global run cap; over the cap returns 429 | `10` |
| `DBT_RUNNER_UVICORN_WORKERS` | Uvicorn worker count | `1` |
| `LOG_LEVEL` | Logging level | `INFO` |

The full list lives in [`app/config.py`](app/config.py).

---

## Interactive API Docs

When running, access interactive documentation at:
- **Swagger UI:** http://localhost:8080/docs
- **ReDoc:** http://localhost:8080/redoc
