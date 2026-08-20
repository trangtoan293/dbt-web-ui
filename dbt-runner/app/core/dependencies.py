"""
FastAPI dependency injection.
Provides service instances for route handlers.
"""

from functools import lru_cache

from app.services.command import CommandService
from app.services.dbt_service import DbtService
from app.services.file_service import FileService
from app.services.git_service import GitService
from app.services.project import ProjectService


@lru_cache()
def get_command_service() -> CommandService:
    """Get singleton CommandService instance."""
    return CommandService()


def get_project_service() -> ProjectService:
    """Get ProjectService instance."""
    return ProjectService()


def get_dbt_service() -> DbtService:
    """Get DbtService instance with dependencies."""
    return DbtService(
        command_service=get_command_service(), project_service=get_project_service()
    )


def get_git_service() -> GitService:
    """Get GitService instance with dependencies."""
    return GitService(
        command_service=get_command_service(), project_service=get_project_service()
    )


def get_file_service() -> FileService:
    """Get FileService instance with dependencies."""
    return FileService(project_service=get_project_service())
