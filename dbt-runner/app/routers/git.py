"""
Git operations router.
"""

from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_user, resolve_user_id
from app.core.db import get_session
from app.core.dependencies import get_git_service
from app.exceptions import GitOperationError
from app.models.git import (
    GitAddRemoteRequest,
    GitCheckoutRequest,
    GitCloneRequest,
    GitCommitRequest,
    GitConfigRequest,
    GitFetchRequest,
    GitInitRequest,
    GitPullRequest,
    GitPushRequest,
)
from app.services.git_service import GitService

router = APIRouter(prefix="/git", tags=["Git"])


def _get_commit_identity(claims: dict) -> tuple[str, str]:
    """Build a Git identity from the authenticated OIDC claims."""
    email = claims.get("email")
    if not email:
        raise HTTPException(
            status_code=400,
            detail="Authenticated user does not have an email for Git commits",
        )

    name = claims.get("name") or claims.get("preferred_username") or email
    return name, email


async def _verify_project_ownership(
    session: AsyncSession, project_id: str, user_id: str
) -> None:
    """Raise 404 if project doesn't exist or isn't owned by user_id (Prisma UUID)."""
    result = await session.execute(
        text(
            "SELECT id FROM dbt_projects "
            "WHERE id = CAST(:pid AS uuid) AND created_by = CAST(:uid AS uuid) "
            "AND deleted_at IS NULL"
        ),
        {"pid": project_id, "uid": user_id},
    )
    if not result.first():
        raise HTTPException(status_code=404, detail="Project not found")


@router.post("/clone")
async def git_clone(
    request: GitCloneRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Clone a Git repository for a project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    try:
        return await service.clone(request, session=session, user_id=user_id)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/pull")
async def git_pull(
    request: GitPullRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Pull latest changes for a project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    try:
        return await service.pull(request, session=session, user_id=user_id)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/commit")
async def git_commit(
    request: GitCommitRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Stage all changes and commit."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    user_name, user_email = _get_commit_identity(claims)
    return await service.commit(request, user_name, user_email)


@router.post("/push")
async def git_push(
    request: GitPushRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Push commits to remote repository."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    try:
        return await service.push(request, session=session, user_id=user_id)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/exec")
async def git_exec(
    project_id: str,
    command: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """
    Execute a git command in the project directory.
    Command should NOT include 'git' prefix.
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    return await service.exec_command(project_id, command)


@router.get("/status/{project_id}")
async def git_status(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Get git status of the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    return await service.get_status(project_id)


@router.get("/log/{project_id}")
async def git_log(
    project_id: str,
    limit: int = 50,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Get commit history for the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    return await service.get_log(project_id, limit)


@router.get("/branches/{project_id}")
async def git_branches(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Get list of branches for the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    return await service.get_branches(project_id)


@router.post("/init")
async def git_init(
    request: GitInitRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Initialize a new git repository for a project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    try:
        return await service.init(request)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/remote/add")
async def git_add_remote(
    request: GitAddRemoteRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Add a remote to the git repository."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    try:
        return await service.add_remote(request)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.get("/remotes/{project_id}")
async def git_remotes(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Get list of remotes for the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    return await service.get_remotes(project_id)


@router.get("/config/{project_id}")
async def get_git_config(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Get git user config for the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    return await service.get_config(project_id)


@router.post("/config")
async def git_config(
    request: GitConfigRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Configure git user for the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    try:
        return await service.set_config(request)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/checkout")
async def git_checkout(
    request: GitCheckoutRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Checkout a branch."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, request.project_id, user_id)
    try:
        return await service.checkout(request)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/fetch/{project_id}")
async def git_fetch(
    project_id: str,
    request: Optional[GitFetchRequest] = Body(None),
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Fetch updates from remote."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.fetch(
            project_id,
            username=request.username if request else None,
            token=request.token if request else None,
            session=session,
            user_id=user_id,
        )
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.get("/diff/{project_id}")
async def git_diff(
    project_id: str,
    file_path: Optional[str] = None,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Get diff of changes."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    return await service.get_diff(project_id, file_path)


@router.post("/add")
async def git_add(
    project_id: str,
    files: Optional[List[str]] = None,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Stage files for commit."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.add(project_id, files)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/reset")
async def git_reset(
    project_id: str,
    files: Optional[List[str]] = None,
    hard: bool = False,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: GitService = Depends(get_git_service),
):
    """Unstage files or reset changes."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.reset(project_id, files, hard)
    except GitOperationError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
