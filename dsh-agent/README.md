# dsh-agent

The dbt assistant: one [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
session per dbt project, streamed to the IDE over SSE.

Part of the stack - `docker compose up -d` starts it and the panel appears in
`/develop`. To turn the feature off, set `AGENT_URL` empty in the frontend's
environment.

**Model providers belong to the user, in the harness's own shape.** dbt-craft
stores them the way `llm-pi-ai` takes them - a dict keyed by route, each naming a
credential *reference*, with the secrets in a separate table - so a catalog
provider needs only a key while any other gateway declares its protocol,
endpoint and models. Per prompt, the frontend proxy attaches the dict as
`X-Model-Providers` and the secrets as `X-Model-Credentials`; this service turns
the dict into a per-session `--patch` overlay for that adapter and the secrets
into that process's environment (`app/model_config.py`). It never reads the
database, so it never decrypts anything.

A deployment-wide key in this container's environment is only a fallback for
users who configured nothing, and `GET /health` reports whether it exists.

Because the harness fixes both its adapter config and its environment at spawn, a
change restarts the session process (`SessionRegistry.acquire` compares
`ModelConfig.fingerprint`). The conversation is not lost - the next process
resumes it from the session log.

```
browser ──► /api/agent (Next.js proxy) ──► dsh-agent ──► dsh --profile dbtcraft
                                               │              │
                                               │              └─► fs tools, sandboxed to
                                               │                  the project directory
                                               └─────────────────► dbt-runner (via the
                                                                   dbt MCP server)
```

## Why a separate service

dbt-runner derives each DuckDB run's memory limit from **its own** cgroup limit
divided by `MAX_CONCURRENT_DBT_RUNS` (`app/core/duckdb_resources.py`). A harness
session is a long-lived Node process with a model context; running those in that
container would spend memory the arithmetic cannot see. It also keeps a Node
runtime out of the dbt image.

## What the agent may and may not do

| Action | How |
|---|---|
| Read, search, edit project files | The harness's own `fs` and `glob`/`grep` tools, fenced to the project directory by `sandbox-policy` in `workspace-write` mode |
| Run dbt, compile a model, query the warehouse | The `dbt` MCP server (`dbt_mcp/`), which calls dbt-runner |
| Reach the database, decrypt a stored credential | Never. This service gets neither `DATABASE_URL` nor `APP_ENCRYPTION_KEY` |

dbt never runs from the agent's shell: DuckDB is single-writer, a warm worker
holds the project's database file open, and per-run memory is budgeted. Going
through dbt-runner means the run appears in History like any other, holds the
same locks, and counts against the same semaphore.

Authorization is delegated: every request's bearer is checked by asking
dbt-runner for something project-scoped (`app/authz.py`). Reimplementing OIDC
verification and ownership here would be a second copy of rules that must not
drift.

## The profile

The harness is not vendored or forked. `profile/cordis.patch.yml` is a patch
layer over the shipped `@deepseek-ai/dsh-base` bundle (76 rows: fs + glob/grep,
spill, sandbox, skills, plan mode, compaction, subagents, todo). The layer adds
three rows and overrides three:

| Row | Why |
|---|---|
| `jsonrpc` | The stdio JSON-RPC transport this service drives |
| `mcp-dbt` | The dbt tools above |
| `session-resume` | `plugins/dsh-session-resume` - see below |
| `session-persistence-jsonl` | Sessions live under the project, not the shared home |
| `system-prompt` | base ships an empty persona |
| `web-search-deepseek`, `tool-web` | An on-premise deployment has no internet |

A patch **replaces a row's whole config** - there is no deep merge - so an
override restates every field it keeps. `dsh --profile dbtcraft --dump-config`
prints the composed tree; the Docker build runs it so a patch naming a row that
does not exist fails the build rather than the first request.

### Why `dsh-session-resume` exists

The SDK JSON-RPC wire has no cancel and no per-session close, so stopping a turn
means killing the process. But `dsh-sdk-jsonrpc-server` only ever calls
`ctx.agents.create()`, and a session id whose log is already on disk fails there
with *"already has a persisted log on disk; load/resume it instead of creating"* -
the prompt is dropped. The plugin routes a known id to `ctx.agents.resume()`
instead, which is what makes stop, restart and idle reclaim survivable.

It also refuses a session id persisted under a different working directory: the
id arrives from an out-of-process caller, and resuming another project's session
would hand over its history.

## Known limitation: one container sees every project

The sandbox modes govern **file effects**, not reads. A session's writes are
fenced to its own project directory - verified: a write to another project under
`/workspace/dbt-projects` is refused with *"file access denied under
workspace-write mode"*, and the escalation to `danger-full-access` fails closed
because no approval channel is mounted. A **read** of another project's file
succeeds, because no mode restricts reads.

That is weaker than the rest of dbt-craft, where dbt-runner answers 404 for
another user's project. Enable the assistant knowingly: it is off by default
(`--profile agent`), and in a deployment where every project belongs to the same
team the exposure is the same as shell access to the projects volume.

Closing it needs isolation the harness cannot provide from configuration:

- **One container per project** - the honest fix. Needs the service to start
  containers (a Docker socket) instead of subprocesses.
- **A mount namespace per session** - `bwrap`/`unshare` binding only that
  project at the workspace path. Cheaper, but needs user namespaces or
  `SYS_ADMIN` in the container, so it is not portable across hosts.
- Per-project uids with a shared group would not help as things stand: dbt-runner
  and this service deliberately share uid 1000 so each can read what the other
  writes.

Do not treat `WORKSPACE_DIR` as free: keeping projects **out of `/tmp`** is what
makes the write fence work at all. `workspace-write` grants the session's own
directory *plus* `/tmp`, so with dbt-runner's `/tmp/dbt-projects` path every
project would be writable from every session.

## Development

```bash
cd dsh-agent
uv venv && uv pip install -e ".[test]"
uv run pytest -q                      # 22 unit tests, no services needed

# Against a real harness (needs Node, a dsh installation and a profile):
DSH_HOME=~/.dsh DSH_BIN=dsh DSH_PROFILE=dbtcraft \
  python3 plugins/dsh-session-resume/test_resume.py
# add DSH_LIVE=1 to also assert the resumed model recalls the earlier turn
# (needs a key in $DSH_HOME/.credentials.yaml)

uvicorn app.main:app --reload --port 8090
```

Startup boots the profile once and fails loud if it cannot serve: a composition
can answer `initialize` and still exit 0 on an immediate `shutdown` while entries
behind it failed to load, which is what a missing native module looks like.

## Gotchas

- **The image needs install scripts to run.** npm 11 defers them, which leaves
  `koffi` without its native module; `subprocess-local` and `sandbox-local` then
  fail to load. The Dockerfile approves them and compiles koffi in a builder
  stage (it ships source only), so the runtime image carries no toolchain.
- **`dsh plugin add` needs `-w`.** `dsh` writes a `pnpm-workspace.yaml` into the
  profile directory, which makes it a workspace root pnpm refuses to add to
  implicitly.
- **Pin `@deepseek-ai/dsh`.** It is a developer preview with breaking changes.
  Everything here rests on `ctx.agents.create/resume`,
  `ctx.sessionPersistence.list()` and the three-method SDK wire; run
  `test_resume.py` after every upgrade.
- **stdout is the protocol.** Never add a row that logs to stdout, or every
  frame becomes unparseable. Diagnostics go to stderr.
- **The harness answers `initialize` before its MCP client has discovered
  anything.** A prompt sent in that window is assembled with no dbt tools at
  all, silently - verified: a fast first turn answered without them while a slow
  one picked them up mid-turn. So the shim writes a readiness file when it serves
  `tools/list`, and `HarnessSession.start()` waits for it
  (`AGENT_MCP_READY_TIMEOUT`, then continues without them rather than refusing
  the prompt). `failOnStartupError` does not close this: the JSON-RPC plugin
  starts serving as soon as it activates, independently of the MCP row.
- **Drain the harness's stderr.** It is inherited by the MCP child, so an unread
  pipe blocks that child and discovery never finishes. Read it in chunks, not
  lines: a child writing megabytes without a newline exceeds StreamReader's line
  limit and kills the reader, which is the same failure again.
  `tests/test_stderr_drain.py` fails if either half regresses.
- **The harness creates files 0600** and preserves an existing file's mode when
  replacing it (`fs-local/src/fsio.ts`). dbt-runner reads them because this
  container shares its uid (1000) - that is what the `USER node` line in the
  Dockerfile is for, not tidiness.
- **An empty environment variable is not an unset one.** Compose writes `""`
  for optional variables, and the DeepSeek adapter used an empty
  `DEEPSEEK_BASE_URL` verbatim - every model request failed with
  `request to  failed`. `HarnessSession.start()` drops empty values before spawn.
- One session is one process, and one process answers one prompt at a time.
