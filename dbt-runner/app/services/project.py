"""
Project management service.
Handles project paths and validation.
"""

import logging
from pathlib import Path
from typing import Optional

from app.config import settings
from app.exceptions import InvalidPathException, ProjectNotFoundException

logger = logging.getLogger(__name__)


class ProjectService:
    """Service for project path management."""

    @staticmethod
    def get_path(project_id: str) -> Path:
        """
        Get the local path for a project.

        Args:
            project_id: Project identifier

        Returns:
            Path to project directory
        """
        return Path(settings.workspace_dir) / project_id

    @classmethod
    def get_path_or_raise(cls, project_id: str) -> Path:
        """
        Get project path and raise if not exists.

        Args:
            project_id: Project identifier

        Returns:
            Path to project directory

        Raises:
            ProjectNotFoundException: If project doesn't exist
        """
        path = cls.get_path(project_id)
        if not path.exists():
            raise ProjectNotFoundException(project_id)
        return path

    @classmethod
    async def get_or_sync(cls, project_id: str) -> Path:
        """
        Get project path, sync from storage if missing.

        This method checks if a project exists locally. If not, it attempts
        to download the project from Supabase Storage for cross-device sync.

        Args:
            project_id: Project identifier

        Returns:
            Path to project directory

        Raises:
            ProjectNotFoundException: If project doesn't exist locally or in storage
        """
        from app.services.storage_service import get_storage_service

        path = cls.get_path(project_id)

        # If exists locally, return immediately
        if path.exists():
            return path

        # Try to sync from storage
        logger.info(
            f"Project {project_id} not found locally, attempting sync from storage..."
        )
        storage_service = get_storage_service()

        if storage_service.enabled:
            success = await storage_service.sync_from_storage(project_id, path)
            if success and path.exists():
                logger.info(f"Successfully synced project {project_id} from storage")
                return path

        # If still doesn't exist, raise error
        raise ProjectNotFoundException(project_id)

    @staticmethod
    async def lazy_sync_from_storage(project_id: str) -> Path:
        """
        Get project path and sync from storage if empty (lazy loading).

        This method is for EXPLICIT sync triggers only - it will download
        project files from storage if the local folder is empty.

        Use this when:
        - User explicitly opens a project for editing
        - Restoring a deleted project

        DO NOT use for file watcher or list views.

        Args:
            project_id: Project identifier

        Returns:
            Path to project directory
        """
        from app.services.storage_service import get_storage_service

        path = Path(settings.workspace_dir) / project_id
        path.mkdir(parents=True, exist_ok=True)

        # Only sync if folder is completely empty
        if not any(path.iterdir()):
            storage_service = get_storage_service()
            if storage_service.enabled:
                manifest = await storage_service._get_manifest(project_id)
                if manifest and "latest_snapshot" in manifest:
                    logger.info(f"Lazy loading project {project_id} from storage")
                    synced = await storage_service.sync_from_storage(project_id, path)
                    if synced:
                        logger.info(
                            f"Successfully loaded project {project_id} from storage"
                        )

        return path

    @staticmethod
    def ensure_exists(project_id: str) -> Path:
        """
        Ensure project directory exists, create if needed (no sync).

        This is the lightweight version that just creates the folder
        without any network requests. Use this for file watchers and list views.

        Args:
            project_id: Project identifier

        Returns:
            Path to project directory
        """
        path = Path(settings.workspace_dir) / project_id
        path.mkdir(parents=True, exist_ok=True)
        logger.debug(f"Ensured project directory exists: {path}")
        return path

    @staticmethod
    def validate_subpath(project_path: Path, relative_path: str) -> Path:
        """
        Validate a path is within the project directory (security check).

        Args:
            project_path: Base project path
            relative_path: Relative path within project

        Returns:
            Validated absolute path

        Raises:
            InvalidPathException: If path is outside project directory
        """
        target_path = project_path / relative_path

        try:
            target_path.resolve().relative_to(project_path.resolve())
        except ValueError:
            raise InvalidPathException(relative_path)

        return target_path

    @staticmethod
    def find_dbt_project(project_path: Path) -> Optional[Path]:
        """
        Find dbt_project.yml in project directory or subdirectories.

        Args:
            project_path: Path to search in

        Returns:
            Path to directory containing dbt_project.yml, or None
        """
        dbt_project_file = project_path / "dbt_project.yml"
        if dbt_project_file.exists():
            return project_path

        # Search in subdirectories
        for subdir in project_path.iterdir():
            if subdir.is_dir() and (subdir / "dbt_project.yml").exists():
                return subdir

        return None
