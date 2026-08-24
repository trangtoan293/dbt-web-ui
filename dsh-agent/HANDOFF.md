# dbt assistant — build journal and hand-off

Integration of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) into dbt-craft as the in-IDE dbt assistant. Written for whoever picks
this up next.

**Status**: running in the default stack, verified end to end against real
services and a real model. `@deepseek-ai/dsh` is a **developer preview**; every
version below is pinned on purpose.

| | |
|---|---|
| Pinned | `@deepseek-ai/dsh@0.1.1-rc.2`, `dsh-sdk-jsonrpc-server@0.0.1-rc.5`, `dsh-sdk-protocol@0.0.1-rc.5` |
| Services | `dsh-agent` (default stack), `dsh-web` (profile `dsh-web`, off by default) |
| Tests | 69 in `dsh-agent`, 109 in `nextjs` (22 of them new here) |
| Migrations | `20260824090000_add_ai_credentials`, `20260824100000_add_ai_providers` |

---

## 1. The decision that shaped everything

The harness is **not vendored, forked, or rebuilt**. It is installed from npm and
extended through its own supported mechanism: a **profile** stacking **bundle
patch layers** (`docs/architecture.md` in the harness repo,
`packages/boot/app-boot/README.md#profiles`).

```
[]  →  @deepseek-ai/dsh-base (76 rows)  →  our cordis.patch.yml  →  --patch overlays
```

Three alternatives were considered and rejected with evidence:

| Option | Why not |
|---|---|
| Python wheel (`deepseek-harness-sdk`) + hand-written `cordis.yml` | The bundled runtime's dependency closure (`python/sdk-runtime/package.json`, 108 packages) **omits `tool-fs-search`** (glob/grep) **and `mcp-client`**. A coding agent without grep on a repo of hundreds of models is materially worse, and MCP is how dbt execution is reached. |
| Rebuild that exe with an extended manifest | Works, but means maintaining a fork build in CI, pinned to each upstream release. |
| Copy `bundle/base/cordis.patch.yml` and maintain our own composition | 76 rows to keep in step with upstream by hand. The patch layer restates 3 rows instead. |

What we add is small: `profile/cordis.patch.yml` inserts three rows
(`jsonrpc`, `mcp-dbt`, `session-resume`) and overrides three
(`session-persistence-jsonl`, `system-prompt`, `web-search-deepseek`/`tool-web`
off). **A patch replaces a row's whole `config`** — there is no deep merge, so an
override restates every field it keeps.

## 2. Architecture

```
browser ──► /api/agent (Next.js proxy, attaches the user's providers + keys)
                │
                ▼
         dsh-agent  ──spawn──►  dsh --profile dbtcraft --patch <per-session>
         (FastAPI)                  │           │
                                    │           └─► fs / glob / grep / bash,
                                    │               sandboxed to the project dir
                                    └─► dbt MCP server ──► dbt-runner
                                                            (run lock, run
                                                             semaphore, History)
```

Its own container on purpose: dbt-runner divides **its** cgroup limit among
DuckDB runs (`dbt-runner/app/core/duckdb_resources.py`), and a harness session is
a long-lived Node process with a model context. Spending memory dbt-runner cannot
see would break that arithmetic.

**The agent edits files directly but never runs dbt itself.** DuckDB is
single-writer, a warm worker holds the project's database file open, and per-run
memory is budgeted — a shell `dbt run` would either fail on the lock or
over-commit the box. Going through dbt-runner also puts the run in History like
any other.

**Authorization is delegated**: `app/authz.py` asks dbt-runner for something
project-scoped with the caller's own bearer. This service gets neither
`DATABASE_URL` nor `APP_ENCRYPTION_KEY`, so a second copy of ownership rules
cannot drift from the first.

## 3. What was built

### `dsh-agent/` (new service, ~3.2k lines including tests)

| File | Role |
|---|---|
| `app/main.py` | FastAPI: prompt (SSE), stop, sessions, history, health |
| `app/harness.py` | One harness process per session over JSON-RPC stdio; event normalization |
| `app/registry.py` | Session slots: capped, idle-reclaimed, restarted when configuration changes |
| `app/model_config.py` | The caller's provider routes and secrets, off the request |
| `app/sessions.py` | Reading conversations back out of the harness's session log (zstd) |
| `app/authz.py` | Ownership delegated to dbt-runner |
| `app/harness_ui.py` | Mirrors providers/keys into the harness UI's own documents |
| `dbt_mcp/__main__.py` | MCP server: `list_models`, `compile_model`, `query`, `run_dbt` |
| `profile/cordis.patch.yml` | The profile layer over `dsh-base` |
| `plugins/dsh-session-resume/` | Upstream gap fix — see finding 4 |
| `Dockerfile` | Two stages: koffi compiles with CMake in the builder only |

### Frontend (~1.7k lines)

| File | Role |
|---|---|
| `src/lib/api/proxy.ts` | Extracted from the dbt-runner route; both proxies now share it |
| `src/app/api/agent/[...path]/route.ts` | Attaches `X-Model-Providers` / `X-Model-Credentials` server-side |
| `src/app/api/ai-providers/route.ts` | Provider CRUD; never returns a key |
| `src/lib/ai-providers.ts` | Provider + credential store, in the harness's own shape |
| `src/lib/hooks/useAgentStream.ts` | SSE consumer: streaming, history, sessions, todos, usage |
| `src/lib/hooks/useAgentAvailability.ts` | Whether this deployment has an assistant that can answer |
| `src/components-v2/develop/agent/AgentPanel.tsx` | The conversation, docked in the IDE |
| `src/components-v2/settings/AssistantProvidersCard.tsx` | Provider management in Settings |

### Data model — the harness's own split

Providers (settings) are kept apart from credentials (secrets), exactly as the
harness keeps `settings.yaml` apart from `.credentials.yaml`:

```
ai_providers     route, apiKeyEnv, api?, baseUrl?, models[], defaultModel, isDefault
                 ↳ the shape llm-pi-ai's `providers` dict takes. No secret here.
ai_credentials   (userId, credentialName) → apiKeyEncrypted
                 ↳ encrypted with APP_ENCRYPTION_KEY, write-only to the browser
```

A catalog route (`deepseek`, `openai`, `anthropic`, …) needs only a key; a gateway
pi-ai does not ship declares `api` + `baseURL` + `models`. Both are configuration,
not code — which is the point.

## 4. Findings from actually running it

Ordered as they were found; each was uncovered by fixing the one before. Every
one of these is a bug that unit tests alone would not have surfaced.

1. **The SDK JSON-RPC wire has no cancel and no session close.** Only
   `initialize`, `session/prompt`, `shutdown` (`packages/sdk/protocol/src/types.ts`).
   → Stop kills the process; one session is one process.
2. **`dsh plugin add` needs `-w`.** `dsh` writes a `pnpm-workspace.yaml` into the
   profile directory, making it a workspace root pnpm refuses to add to
   implicitly.
3. **npm defers install scripts**, leaving `koffi` without its native module;
   `subprocess-local` and `sandbox-local` then fail to load. koffi ships source
   only → compile it in a builder stage.
4. **Resuming a session failed outright**: `ctx.agents.create()` rejects a session
   id whose log exists (*"already has a persisted log on disk; load/resume it
   instead of creating"*), and the SDK transport only ever creates. The prompt was
   silently dropped. → `plugins/dsh-session-resume` routes a known id to
   `ctx.agents.resume()`. It also refuses an id persisted under another working
   directory, since the id arrives from an out-of-process caller.
5. **`COPY` dereferences symlinks**: copying `/usr/local/bin/dsh` produced a real
   file, so Node resolved the harness's packages from `/usr/local/bin`. → recreate
   the symlink in the runtime stage.
6. **`dsh-sdk-protocol` is the one peer the installation does not carry.**
7. **A `pnpm link:` target must exist in the runtime stage too**, or the plugin
   row fails to import.
8. **`workspace-write` grants the session's directory *plus* `/tmp`** — and
   dbt-runner mounts projects at `/tmp/dbt-projects`, so every project was
   writable from every session. → the agent container mounts the same volume at
   `/workspace/dbt-projects`. Verified both ways.
9. **Undrained stderr blocks the MCP child.** The harness inherits stderr to the
   MCP server it spawns; an unread pipe fills and discovery never completes — the
   agent then runs with **no dbt tools and nothing logged** (this composition has
   no logger row). Read it in **chunks**, not lines: a child writing megabytes
   without a newline exceeds `StreamReader`'s line limit and kills the reader,
   which is the same failure with an extra step.
10. **The harness answers `initialize` before MCP discovery finishes.** A fast
    first turn was assembled with no dbt tools; a slow one picked them up
    mid-turn. `failOnStartupError` does not close it — the JSON-RPC plugin serves
    as soon as *it* activates. → the shim writes a readiness file when it serves
    `tools/list`; `HarnessSession.start()` waits for it.
11. **An empty environment variable is not an unset one.** Compose writes `""` for
    optional variables and the DeepSeek adapter used an empty `DEEPSEEK_BASE_URL`
    verbatim: *"DeepSeek API request to  failed"*. → empty values are dropped
    before spawn. The same trap hit `dsh-web`: the harness ranks the inherited
    environment **above** its own credential file, so an empty `DEEPSEEK_API_KEY`
    read as "configured with nothing" and that UI kept asking for a key it had.
12. **`compression: none` on the session log is not free**: the backend refuses a
    root already holding zstd logs, which would abandon every existing
    conversation. → keep the harness's default and decode zstd here
    (`read_across_frames=True`; the harness appends one frame per flush).
13. **The IDE only refreshed the root of the file tree.** The file endpoint returns
    one level, so a file written into an expanded `models/marts` never appeared
    until it was collapsed and expanded again — which read as "the agent put it in
    the wrong folder". The watcher itself was fine (verified: `created` +
    `modified` arrive from a cross-container write). → refresh every *expanded*
    ancestor of the changed path.
14. **`fs-local` creates new files `0600`** and preserves an existing file's mode
    when replacing (`packages/fs/fs-local/src/fsio.ts:566`). A umask does not move
    it. It works because dsh-agent and dbt-runner share uid 1000 — that is what
    `USER node` in the Dockerfile is for.

## 5. Verified

Against the real stack (Postgres, Redis, dbt-runner, a real project) with a live
model, unless noted.

| Behaviour | Evidence |
|---|---|
| Agent writes a model | `write models/marts/…` → file on the shared volume, visible to dbt-runner |
| dbt runs through dbt-runner | History row `success run selector='orders_summary' models=1/1`; runner log `[DBT-PERF] command lock_wait run_id=101f3850…` |
| Warm worker really holds the file | reading `dev.duckdb` directly fails: `Conflicting lock is held in PID 34` |
| The model materialised | `POST /dbt/query` → `{"total":100}`, and the agent read it back through `mcp__dbt__query` |
| Caller's token reaches dbt-runner | shim sent `auth='Bearer live-token-123'`, `project_id`, `limit` |
| Stop → resume | kill the process, prompt the same session → *"The magic word was banana"* |
| Cross-project write refused | *"file access denied under workspace-write mode"*, escalation fails closed, target unchanged |
| Streaming | panel text 413 → 1863 → 1975 chars while a turn ran; token counter `189 in · 355 out · 8064 cached` |
| Provider route from the DB | added route `deepseek` in Settings → prompt answered *"PROVIDER ROUTE OK"* |
| Harness UI stops asking for a key | `asksForKey: false` after providers + credentials were mirrored |
| New file appears without a refresh | `models/marts/probe_live.sql` in the tree in ~2s, `marts` still expanded |
| Startup self-check | caught findings 5, 6, 7 at container start rather than at the first prompt |

## 6. Limitations and risks

- **A session can read another project's files.** Sandbox modes fence *writes*,
  not reads; one container serves every project and dbt-runner shares its uid, so
  file permissions cannot separate them either. Weaker than the rest of dbt-craft,
  where dbt-runner answers 404 for another user's project. Closing it needs
  isolation the harness cannot provide from configuration: a container per project
  (Docker socket) or a mount namespace per session (`bwrap`/`unshare`, needs
  userns or `SYS_ADMIN`, not portable).
- **`dsh-web` has no authentication** and can run code in every project on the
  volume — which is why `dsh web` refuses to bind `0.0.0.0` upstream. It is off by
  default, published on loopback only, and reached through a socat bridge because
  Docker cannot publish a loopback-bound port. Do not expose it; use an SSH tunnel.
  Its credential mirroring is refused unless `AUTH_DISABLED=true`.
- **Developer preview.** The integration rests on `ctx.agents.create/resume`,
  `ctx.sessionPersistence.list()`, the three-method JSON-RPC wire, `llm-pi-ai`'s
  `providers` dict, and the session log format. Run
  `plugins/dsh-session-resume/test_resume.py` after every upgrade.
- **No cancel on the wire**, so Stop kills the process and one session is one
  process. Sessions stay live until shutdown (upstream limitation), hence the cap
  and idle reclaim.
- **Permission prompts, plan approval and mode switching are unreachable** over
  this transport — they need a request *back* to the harness, which the SDK wire
  does not have. The header link to the harness's own UI exists for exactly that.
- **One provider per deployment for `AGENT_PROVIDER`'s fallback**; a user's key is
  used against the route they configured.

## 7. Next steps, in the order I would take them

1. **Model picker in the panel header** — routes and models already come back from
   `/api/ai-providers`; today changing them means a trip to Settings.
2. **Per-project provider override** — some projects sit on a different gateway.
3. **Read isolation** (see limitations) if this is ever exposed to mutually
   untrusted users. One container per project is the honest fix.
4. **Cancel without killing** — needs either an upstream method on the SDK wire or
   moving to the ACP transport (which has `session/cancel` but a much poorer event
   stream: committed messages only, no tool presentation).
5. **Surface `run_dbt` results as History links** in the panel; the run id is
   already in the tool result.

## 8. Running it

```bash
docker compose up -d                      # dsh-agent is part of the default stack
docker compose --profile dsh-web up -d dsh-web   # optional harness UI, loopback only

cd dsh-agent && uv venv && uv pip install -e ".[test]" && uv run pytest -q
cd nextjs && npx vitest run

# End-to-end against a real harness (needs Node, a dsh installation, a profile):
DSH_HOME=~/.dsh DSH_BIN=dsh DSH_PROFILE=dbtcraft \
  python3 plugins/dsh-session-resume/test_resume.py
# add DSH_LIVE=1 to also assert the resumed model recalls the earlier turn

dsh --profile dbtcraft --dump-config      # the composed tree, 80 rows
```

Users add their own model key in **Settings → Assistant model providers**. A
deployment-wide `DEEPSEEK_API_KEY` is only a fallback for users who configured
nothing.

Architecture decisions live in the root `CLAUDE.md`; this service's own gotchas
live in `dsh-agent/README.md`.
