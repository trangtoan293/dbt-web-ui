"""
Project management router for deletion/restoration operations with storage sync.
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.project import ProjectService
from app.services.storage_service import get_storage_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/project", tags=["Project"])


class ProjectDeleteRequest(BaseModel):
    """Request model for project deletion."""

    project_id: str
    hard_delete: bool = False  # True for permanent deletion, False for soft delete


class ProjectRestoreRequest(BaseModel):
    """Request model for project restoration."""

    project_id: str


@router.post("/delete")
async def delete_project(request: ProjectDeleteRequest):
    """
    Delete a project (soft or hard delete) with storage cleanup.

    - Soft delete: Marks project as deleted but keeps files for recovery
    - Hard delete: Permanently removes project and all storage files
    """
    try:
        project_service = ProjectService()
        storage_service = get_storage_service()

        # Check if project exists
        project_path = project_service.get_path(request.project_id)
        if not project_path.exists() and not request.hard_delete:
            logger.warning(
                f"Project {request.project_id} not found locally for soft delete"
            )

        if request.hard_delete:
            # Hard delete: Remove from storage permanently
            logger.info(f"Hard deleting project {request.project_id}")
            storage_deleted = await storage_service.delete_from_storage(
                request.project_id
            )

            if not storage_deleted:
                logger.warning(
                    f"Failed to delete project {request.project_id} from storage"
                )

            return {
                "success": True,
                "message": f"Project {request.project_id} permanently deleted",
                "storage_cleaned": storage_deleted,
            }
        else:
            # Soft delete: First sync current state, then mark as deleted
            logger.info(f"Soft deleting project {request.project_id}")

            # Sync current files before marking deleted (preserve final state)
            if project_path.exists() and any(project_path.iterdir()):
                await storage_service.sync_files_to_storage(
                    request.project_id, project_path
                )
                logger.info(
                    f"Synced project {request.project_id} before soft delete (direct)"
                )

            storage_marked = await storage_service.mark_deleted(request.project_id)

            if not storage_marked:
                logger.warning(
                    f"Failed to mark project {request.project_id} as deleted in storage"
                )

            return {
                "success": True,
                "message": f"Project {request.project_id} moved to trash",
                "storage_marked": storage_marked,
            }

    except Exception as e:
        logger.error(f"Error deleting project {request.project_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/restore")
async def restore_project(request: ProjectRestoreRequest):
    """
    Restore a soft-deleted project.

    Clears the deleted_at flag from storage manifest and re-syncs files.
    """
    try:
        project_service = ProjectService()
        storage_service = get_storage_service()

        logger.info(f"Restoring project {request.project_id}")

        # Restore in storage (clear deleted_at from manifest)
        storage_restored = await storage_service.restore_project(request.project_id)

        if not storage_restored:
            logger.warning(f"Failed to restore project {request.project_id} in storage")

        # If project doesn't exist locally or is empty, sync from storage
        project_path = project_service.get_path(request.project_id)
        if not project_path.exists() or not any(project_path.iterdir()):
            logger.info(f"Project {request.project_id} not local, syncing from storage")
            synced = await storage_service.sync_from_storage(
                request.project_id, project_path
            )

            return {
                "success": True,
                "message": f"Project {request.project_id} restored from storage",
                "storage_restored": storage_restored,
                "files_synced": synced,
            }

        return {
            "success": True,
            "message": f"Project {request.project_id} restored",
            "storage_restored": storage_restored,
            "files_synced": False,  # Already exists locally
        }

    except Exception as e:
        logger.error(f"Error restoring project {request.project_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sync/{project_id}")
async def sync_project_from_storage(project_id: str):
    """
    Explicitly sync project files from storage using timestamp-based comparison.

    Called by frontend when user opens a project or clicks Refresh button.
    Always checks all files and downloads if storage version is newer.
    """
    try:
        project_service = ProjectService()
        storage_service = get_storage_service()

        project_path = project_service.get_path(project_id)

        # Create folder if doesn't exist
        project_path.mkdir(parents=True, exist_ok=True)

        # Always sync with timestamp-based comparison
        # This will download:
        # - Missing files
        # - Files where storage version is newer than local
        logger.info(f"Syncing project {project_id} from storage (timestamp-based)...")

        # Try direct file sync with timestamp comparison
        synced = await storage_service.sync_files_from_storage(project_id, project_path)

        if not synced:
            # Fallback to tar-based sync if direct sync fails
            logger.info(f"Direct sync failed, trying tar-based sync for {project_id}")
            synced = await storage_service.sync_from_storage(project_id, project_path)

        if synced:
            logger.info(f"Successfully synced project {project_id} from storage")
        else:
            logger.warning(f"Failed to sync project {project_id} from storage")

        return {
            "success": True,
            "path": str(project_path),
            "synced": synced,
            "message": f"Project synced with timestamp-based comparison",
        }
    except Exception as e:
        logger.error(f"Error syncing project {project_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
