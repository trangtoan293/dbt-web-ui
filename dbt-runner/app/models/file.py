"""
Pydantic models for file operations.
"""

from typing import Optional

from pydantic import BaseModel, Field


class FileCreateRequest(BaseModel):
    """Request to create a new file or directory."""

    path: str = Field(
        ..., description="Relative path (e.g., 'models/staging/new_model.sql')"
    )
    content: Optional[str] = Field(
        "", description="Content for files, empty for directories"
    )
    file_type: str = Field("file", description="Type: 'file' or 'directory'")


class FileSaveRequest(BaseModel):
    """Request to save file content."""

    path: str = Field(..., description="Relative path to the file")
    content: str = Field(..., description="File content to save")
