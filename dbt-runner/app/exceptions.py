"""
Custom exceptions for dbt-runner service.
"""

from typing import Any, Dict, Optional


class DbtRunnerException(Exception):
    """Base exception for all dbt-runner errors."""

    def __init__(
        self,
        message: str,
        status_code: int = 500,
        details: Optional[Dict[str, Any]] = None,
    ):
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(self.message)


class ProjectNotFoundException(DbtRunnerException):
    """Raised when a project is not found."""

    def __init__(self, project_id: str):
        super().__init__(
            message=f"Project not found: {project_id}",
            status_code=404,
            details={"project_id": project_id},
        )


class FileNotFoundException(DbtRunnerException):
    """Raised when a file is not found."""

    def __init__(self, path: str):
        super().__init__(
            message=f"File not found: {path}", status_code=404, details={"path": path}
        )


class InvalidPathException(DbtRunnerException):
    """Raised when a path is invalid or outside project directory."""

    def __init__(self, path: str):
        super().__init__(
            message=f"Invalid path: {path}", status_code=403, details={"path": path}
        )


class CommandExecutionError(DbtRunnerException):
    """Raised when a command fails to execute."""

    def __init__(self, command: str, stderr: str = "", returncode: int = 1):
        super().__init__(
            message=f"Command failed: {command}",
            status_code=400,
            details={"command": command, "stderr": stderr, "returncode": returncode},
        )


class GitOperationError(DbtRunnerException):
    """Raised when a git operation fails."""

    def __init__(self, operation: str, message: str):
        super().__init__(
            message=f"Git {operation} failed: {message}",
            status_code=400,
            details={"operation": operation},
        )


class DbtOperationError(DbtRunnerException):
    """Raised when a dbt operation fails."""

    def __init__(self, operation: str, message: str):
        super().__init__(
            message=f"dbt {operation} failed: {message}",
            status_code=400,
            details={"operation": operation},
        )


class ConnectionError(DbtRunnerException):
    """Raised when a database connection fails."""

    def __init__(self, connection_type: str, message: str):
        super().__init__(
            message=f"Connection failed ({connection_type}): {message}",
            status_code=400,
            details={"connection_type": connection_type},
        )
