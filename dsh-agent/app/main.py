"""dsh-agent: a DeepSeek Harness session per dbt project, streamed over SSE.

Why this is its own service rather than a dbt-runner router: a harness session
is a long-lived Node process with its own memory, and dbt-runner's container
budget is divided among DuckDB runs by cgroup limit
(dbt-runner/app/core/duckdb_resources.py). Putting agents in there would break
that arithmetic. It also keeps dbt-runner free of a Node runtime.

Everything the agent does that touches a warehouse goes back through
dbt-runner's own endpoints (see dbt_mcp), so run locks, the run semaphore and
per-run DuckDB memory limits keep applying.
"""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import httpx

from app.authz import authorize_project
from app.config import settings
from app.harness import HarnessError, verify_composition
from app.harness_ui import provision_credential
from app.model_config import ModelConfig
from app.registry import SessionsFull, registry
from app.sessions import list_sessions, read_history

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger(__name__)



class PromptRequest(BaseModel):
    text: str = Field(..., min_length=1)
    session_id: str | None = Field(
        None, description="Conversation to continue; omitted starts a new one"
    )


class StopRequest(BaseModel):
    session_id: str


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


def create_app() -> FastAPI:
    app = FastAPI(title="dsh-agent", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async def _harness_ui_url() -> str | None:
        """The harness's own UI, but only when something is actually serving it.

        It runs behind a compose profile, so the usual state is "not started".
        Offering a link to a dead port is worse than offering none.
        """
        if not settings.web_url or not settings.web_probe_url:
            return None
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(settings.web_probe_url)
        except httpx.HTTPError:
            return None
        return settings.web_url if response.status_code < 500 else None

    @app.get("/health")
    async def health() -> dict:
        return {
            "status": "ok",
            "profile": settings.dsh_profile,
            "model": settings.model,
            # Whether THIS DEPLOYMENT has a shared fallback key. A user's own
            # key arrives per request, so the UI asks the frontend about that.
            "model_configured": settings.model_credential_present(),
            # A link the panel offers when the harness's own UI is up.
            "web_url": await _harness_ui_url(),
        }

    @app.post("/agent/{project_id}/prompt")
    async def prompt(
        project_id: str,
        body: PromptRequest,
        request: Request,
        authorization: str | None = Header(None),
        x_model_providers: str | None = Header(None),
        x_model_credentials: str | None = Header(None),
        x_model_route: str | None = Header(None),
        x_model_name: str | None = Header(None),
    ) -> StreamingResponse:
        await authorize_project(project_id, authorization)
        session_id = body.session_id or f"{project_id}-{uuid.uuid4().hex[:12]}"
        model_config = ModelConfig.from_headers(
            x_model_providers, x_model_credentials, x_model_route, x_model_name
        )

        try:
            session = await registry.acquire(project_id, session_id, model_config)
        except SessionsFull as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc
        except HarnessError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        # The shim calls dbt-runner as this user, so it gets this request's token
        # and no ambient credential of its own.
        session.write_token(authorization)
        # The harness's own UI resolves providers and credentials from its own
        # documents; hand it the same ones so a single-user deployment configures
        # them once. Refused when OIDC is on - that surface is unauthenticated
        # and shared.
        provision_credential(model_config)

        async def events():
            yield _sse({"type": "session", "session_id": session_id})
            try:
                async for event in session.prompt(body.text):
                    if await request.is_disconnected():
                        # The browser left. The turn keeps running inside the
                        # harness; its events land in the session log and the
                        # next prompt resumes with them.
                        logger.info("client disconnected from %s", session_id)
                        return
                    yield _sse(event)
            except HarnessError as exc:
                yield _sse({"type": "error", "error": str(exc)})
            except Exception as exc:  # noqa: BLE001 - the stream must say why it ended
                logger.exception("agent stream failed")
                yield _sse({"type": "error", "error": f"agent failed: {exc}"})
            finally:
                yield _sse({"type": "done"})

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/agent/{project_id}/sessions")
    async def sessions(
        project_id: str,
        authorization: str | None = Header(None),
    ) -> dict:
        """Every conversation this project has, newest first."""
        await authorize_project(project_id, authorization)
        return {"sessions": list_sessions(project_id)}

    @app.get("/agent/{project_id}/sessions/{session_id}")
    async def history(
        project_id: str,
        session_id: str,
        authorization: str | None = Header(None),
    ) -> dict:
        """Replay one conversation, in the shape the live stream uses."""
        await authorize_project(project_id, authorization)
        return {"session_id": session_id, "events": read_history(project_id, session_id)}

    @app.post("/agent/{project_id}/stop")
    async def stop(
        project_id: str,
        body: StopRequest,
        authorization: str | None = Header(None),
    ) -> dict:
        """Stop a running turn.

        The SDK JSON-RPC wire has no cancel, so this kills the process. The
        conversation survives: dsh-session-resume reopens the persisted session
        on the next prompt.
        """
        await authorize_project(project_id, authorization)
        stopped = await registry.stop(project_id, body.session_id)
        return {"stopped": stopped}

    @app.on_event("startup")
    async def _startup() -> None:
        await verify_composition()

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        await registry.shutdown()

    return app


app = create_app()
