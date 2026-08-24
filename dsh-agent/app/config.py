"""Deployment configuration for dsh-agent.

Everything is an environment variable with a working default, matching how
dbt-runner is configured. The three that must line up with the other services
are STORAGE_DIR, WORKSPACE_DIR and DBT_RUNNER_URL.
"""

import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


class Settings:
    # Where the harness keeps its own state: sessions, credentials, settings.
    # One subdirectory per project, because a session belongs to a project the
    # same way the project's files do.
    storage_dir = Path(os.environ.get("STORAGE_DIR", "/data/storage"))
    # dbt project checkouts: the same volume dbt-runner mounts, but NOT under
    # /tmp here. The harness sandbox's workspace-write mode grants the session's
    # own directory plus /tmp, so with the projects under /tmp one project's
    # agent could write into another project's files.
    workspace_dir = Path(os.environ.get("WORKSPACE_DIR", "/workspace/dbt-projects"))

    dbt_runner_url = os.environ.get("DBT_RUNNER_URL", "http://dbt-runner:8080").rstrip("/")

    # The harness home holds the baked profile (bundles + our patch layer) and
    # the credential file. It is shared by every project: only sessions are
    # per-project, and those are redirected with DSH_SESSION_ROOT.
    dsh_home = Path(os.environ.get("DSH_HOME", "/dsh-home"))
    dsh_bin = os.environ.get("DSH_BIN", "dsh")
    dsh_profile = os.environ.get("DSH_PROFILE", "dbtcraft")
    # Fallback route for a user who configured no provider of their own. The
    # base composition serves `deepseek-official` through its own adapter.
    provider = os.environ.get("AGENT_PROVIDER", "deepseek-official")
    model = os.environ.get("AGENT_MODEL", "deepseek-v4-flash")

    # A live session is a Node process holding a model context, so sessions are
    # capped and reclaimed the way dbt-runner caps warm worker pools.
    max_sessions = _int("AGENT_MAX_SESSIONS", 4)
    idle_seconds = _int("AGENT_IDLE_SECONDS", 900)
    # How long one prompt may run before the process is killed.
    prompt_timeout = _int("AGENT_PROMPT_TIMEOUT", 600)
    # Startup handshake budget: the harness loads ~80 plugins before answering.
    start_timeout = _int("AGENT_START_TIMEOUT", 60)
    # How long to wait for the dbt MCP tools to be discovered after the
    # handshake. Exceeding it starts the session anyway: file editing still
    # works without dbt tools, and refusing the prompt would be worse.
    mcp_ready_timeout = _int("AGENT_MCP_READY_TIMEOUT", 30)

    # The harness's own web UI, if the operator runs one, so the panel can offer
    # a link to it. Deliberately not a service in this compose file: `dsh web`
    # refuses --host 0.0.0.0 ("it would expose remote code execution to the
    # network"), and forwarding around that refusal would defeat its point. Run
    # it where loopback is the right boundary - a workstation - and put its URL
    # here.
    web_url = os.environ.get("AGENT_WEB_URL", "").strip()
    # The address to test before offering that link. It differs from web_url:
    # the browser reaches the harness UI on a published loopback port, while this
    # service reaches the same container over the compose network.
    web_probe_url = os.environ.get("AGENT_WEB_PROBE_URL", "http://dsh-web:3080").strip()
    # The harness UI's own home, on the shared volume, so this service can hand
    # it the caller's key instead of making a person enter it twice.
    web_home = Path(os.environ.get("AGENT_WEB_HOME", "")) if os.environ.get("AGENT_WEB_HOME") else None
    # Single local user. The harness UI has no authentication of its own, so
    # sharing one user's key with it is only safe when there is one user.
    auth_disabled = os.environ.get("AUTH_DISABLED", "").strip().lower() == "true"

    cors_origins = [
        origin.strip()
        for origin in os.environ.get(
            "AGENT_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
        ).split(",")
        if origin.strip()
    ]

    def model_credential_present(self) -> bool:
        """Whether a model credential exists, without reading its value.

        The one thing about this service a deployment must supply itself. The
        harness resolves it from the environment first, then from its own
        credential file, so both count. Reported by /health so the UI can say
        what is missing instead of failing every prompt.
        """
        if os.environ.get("DEEPSEEK_API_KEY", "").strip():
            return True
        credentials = self.dsh_home / ".credentials.yaml"
        try:
            return any(
                line.split(":", 1)[0].strip().endswith("API_KEY")
                and line.split(":", 1)[1].strip()
                for line in credentials.read_text().splitlines()
                if ":" in line and not line.lstrip().startswith("#")
            )
        except OSError:
            return False

    def state_for(self, project_id: str) -> Path:
        """Per-project agent state: session logs and the MCP token file."""
        return self.storage_dir / "agent" / project_id

    def cwd_for(self, project_id: str) -> Path:
        return self.workspace_dir / project_id


settings = Settings()
