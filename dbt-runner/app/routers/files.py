"""
File operations router.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import require_user, resolve_user_id, verify_project_ownership
from app.core.db import get_session
from app.core.dependencies import get_file_service
from app.exceptions import (
    FileNotFoundException,
    InvalidPathException,
    ProjectNotFoundException,
)
from app.models.file import FileCreateRequest, FileSaveRequest
from app.services.file_service import FileService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/files", tags=["Files"])


# Shared with every other router - see app/core/auth.py
_verify_project_ownership = verify_project_ownership


@router.get("/{project_id}")
async def list_files(
    project_id: str,
    path: str = "",
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """List files in a project directory."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.list_files(project_id, path)
    except (ProjectNotFoundException, FileNotFoundException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.get("/{project_id}/search")
async def search_files(
    project_id: str,
    query: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Search for files matching a query in the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.search_files(project_id, query)
    except ProjectNotFoundException as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.get("/{project_id}/content")
async def read_file(
    project_id: str,
    path: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Read file content."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.read_file(project_id, path)
    except (ProjectNotFoundException, FileNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.put("/{project_id}/content")
async def write_file(
    project_id: str,
    path: str,
    content: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Write file content."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.write_file(project_id, path, content)
    except (ProjectNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/{project_id}/create")
async def create_file(
    project_id: str,
    request: FileCreateRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Create a new file or directory in the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.create(project_id, request)
    except (ProjectNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/{project_id}/content")
async def save_file_content(
    project_id: str,
    request: FileSaveRequest,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Save content to an existing file."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.save_content(project_id, request)
    except (ProjectNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.delete("/{project_id}")
async def delete_file(
    project_id: str,
    path: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Delete a file or directory from the project."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.delete(project_id, path)
    except (ProjectNotFoundException, FileNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.put("/{project_id}/rename")
async def rename_file(
    project_id: str,
    old_path: str,
    new_path: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Rename a file or directory."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.rename(project_id, old_path, new_path)
    except (ProjectNotFoundException, FileNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/{project_id}/move")
async def move_file(
    project_id: str,
    source_path: str,
    dest_path: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Move a file or directory to a new location."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.move(project_id, source_path, dest_path)
    except (ProjectNotFoundException, FileNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/{project_id}/copy")
async def copy_file(
    project_id: str,
    source_path: str,
    dest_path: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Copy a file or directory to a new location."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.copy(project_id, source_path, dest_path)
    except (ProjectNotFoundException, FileNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/{project_id}/duplicate")
async def duplicate_file(
    project_id: str,
    path: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """Duplicate a file or directory with _copy suffix."""
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)
    try:
        return await service.duplicate(project_id, path)
    except (ProjectNotFoundException, FileNotFoundException, InvalidPathException) as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.get("/{project_id}/status")
async def get_project_status(
    project_id: str,
    claims: dict = Depends(require_user),
    session: AsyncSession = Depends(get_session),
    service: FileService = Depends(get_file_service),
):
    """
    Check project status - whether it exists and is accessible.

    Returns:
        - exists: Whether project directory exists
        - has_git: Whether project has .git directory
        - has_dbt_project: Whether project has dbt_project.yml
        - has_uncommitted_changes: Whether there are uncommitted Git changes
        - file_count: Number of files in project root
    """
    user_id = await resolve_user_id(session, claims.get("sub"), claims.get("email"))
    await _verify_project_ownership(session, project_id, user_id)

    from pathlib import Path

    from app.services.project import ProjectService

    project_service = ProjectService()
    project_path = project_service.get_path(project_id)

    result = {
        "project_id": project_id,
        "exists": False,
        "has_git": False,
        "has_dbt_project": False,
        "has_uncommitted_changes": False,
        "file_count": 0,
        "path": str(project_path),
    }

    if not project_path.exists():
        return result

    result["exists"] = True
    result["has_git"] = (project_path / ".git").exists()
    result["has_dbt_project"] = (project_path / "dbt_project.yml").exists()

    try:
        result["file_count"] = len(list(project_path.iterdir()))
    except Exception:
        pass

    if result["has_git"]:
        try:
            import subprocess

            proc = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=5,
            )
            result["has_uncommitted_changes"] = bool(proc.stdout.strip())
        except Exception:
            pass

    return result
