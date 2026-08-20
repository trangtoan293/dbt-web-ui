"""
Core utilities exports.
"""

from app.core.logging import setup_logging

__all__ = [
    "get_command_service",
    "get_project_service",
    "get_dbt_service",
    "get_git_service",
    "get_file_service",
    "setup_logging",
]


def __getattr__(name: str):
    if name in {
        "get_command_service",
        "get_project_service",
        "get_dbt_service",
        "get_git_service",
        "get_file_service",
    }:
        from app.core import dependencies

        return getattr(dependencies, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
