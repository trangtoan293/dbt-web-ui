"""
Dremio router. Ported from the Supabase `dremio-adapter` edge function.

Dremio source CRUD plus query execution against the Dremio REST API. Data
access goes through Postgres (SQLAlchemy); every endpoint is scoped to the
authenticated OIDC user (dremio_sources.created_by).
"""

import asyncio
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_user, resolve_user_id
from app.core.crypto import decrypt_secret_or_plaintext, encrypt_secret
from app.core.db import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dremio", tags=["Dremio"])

POLL_INTERVAL_SECONDS = 1.0
POLL_MAX_ATTEMPTS = 30


class CreateSourceRequest(BaseModel):
    name: str
    dremio_host: str
    dremio_port: int = 9047
    token: str
    username: str = "admin"
    catalog_name: Optional[str] = None
    arrow_flight_port: int = 32010


class QueryRequest(BaseModel):
    source_id: str
    sql: str
    limit: int = 100


async def _get_owned_source(session: AsyncSession, source_id: str, user_id: str) -> dict:
    result = await session.execute(
        text(
            "SELECT id, name, host, port, token_encrypted, catalog, arrow_flight_port "
            "FROM dremio_sources "
            "WHERE id = CAST(:sid AS uuid) AND created_by = CAST(:uid AS uuid)"
        ),
        {"sid": source_id, "uid": user_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Source not found")
    return dict(row)


@router.get("/sources")
async def list_sources(
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    result = await session.execute(
        text(
            "SELECT id, name, host, port, catalog, arrow_flight_port "
            "FROM dremio_sources WHERE created_by = CAST(:uid AS uuid) ORDER BY name"
        ),
        {"uid": user_id},
    )
    return [dict(row) for row in result.mappings().all()]


@router.post("/sources", status_code=201)
async def create_source(
    body: CreateSourceRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    result = await session.execute(
        text(
            "INSERT INTO dremio_sources "
            "(name, host, port, username, token_encrypted, catalog, arrow_flight_port, created_by) "
            "VALUES (:name, :host, :port, :username, :token, :catalog, :afp, CAST(:uid AS uuid)) "
            "RETURNING id, name, host, port, catalog, arrow_flight_port"
        ),
        {
            "name": body.name,
            "host": body.dremio_host,
            "port": body.dremio_port,
            "username": body.username,
            "token": encrypt_secret(body.token),
            "catalog": body.catalog_name or "",
            "afp": body.arrow_flight_port,
            "uid": user_id,
        },
    )
    row = result.mappings().first()
    await session.commit()
    return dict(row)


@router.post("/sources/{source_id}/test")
async def test_source(
    source_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    source = await _get_owned_source(session, source_id, user_id)
    url = f"http://{source['host']}:{source['port']}/api/v3/catalog"
    token = decrypt_secret_or_plaintext(source["token_encrypted"])
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                url, headers={"Authorization": f"Bearer {token}"}
            )
        if resp.status_code == 200:
            return {"success": True, "message": "Connection successful"}
        raise HTTPException(status_code=400, detail=f"Dremio returned {resp.status_code}")
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/query")
async def run_query(
    body: QueryRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    source = await _get_owned_source(session, body.source_id, user_id)
    base = f"http://{source['host']}:{source['port']}/api/v3"
    token = decrypt_secret_or_plaintext(source["token_encrypted"])
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    context = [source["catalog"]] if source.get("catalog") else None

    async with httpx.AsyncClient(timeout=30.0) as client:
        submit = await client.post(f"{base}/sql", headers=headers, json={"sql": body.sql, "context": context})
        if submit.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Dremio query failed: {submit.text}")
        job_id = submit.json().get("id")

        job_state = "RUNNING"
        results = None
        attempts = 0
        while job_state == "RUNNING" and attempts < POLL_MAX_ATTEMPTS:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            status_resp = await client.get(f"{base}/job/{job_id}", headers=headers)
            job_state = status_resp.json().get("jobState")
            if job_state == "COMPLETED":
                res = await client.get(
                    f"{base}/job/{job_id}/results", headers=headers, params={"limit": body.limit}
                )
                results = res.json()
            attempts += 1

    if job_state == "COMPLETED" and results is not None:
        return {
            "job_id": job_id,
            "status": "completed",
            "rows": results.get("rows"),
            "schema": results.get("schema"),
            "row_count": results.get("rowCount"),
        }
    if job_state == "FAILED":
        raise HTTPException(status_code=400, detail="Query execution failed")
    # Still running after max attempts
    return {"job_id": job_id, "status": "timeout", "message": "Query still running, check back later"}


@router.get("/catalog")
async def get_catalog(
    source_id: str,
    path: str = "",
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    source = await _get_owned_source(session, source_id, user_id)
    base = f"http://{source['host']}:{source['port']}/api/v3"
    url = f"{base}/catalog/by-path/{path}" if path else f"{base}/catalog"
    token = decrypt_secret_or_plaintext(source["token_encrypted"])
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Failed to fetch catalog: {resp.status_code}")
        return resp.json()
