"""
Pydantic models for dbt documentation operations.
"""

from typing import Optional

from pydantic import BaseModel, Field


class DocsGenerateRequest(BaseModel):
    """Request to generate dbt documentation."""

    project_id: str = Field(..., description="Project identifier")
    select: Optional[str] = Field(
        None, description="Optional model selector to limit docs generation"
    )


class DocsGenerateResponse(BaseModel):
    """Response from dbt docs generate command."""

    success: bool
    message: str
    catalog_path: Optional[str] = None
    manifest_path: Optional[str] = None


class DocsServeRequest(BaseModel):
    """Request to start dbt docs server."""

    project_id: str = Field(..., description="Project identifier")
    port: Optional[int] = Field(
        None,
        ge=1024,
        le=65535,
        description="Port for docs server (auto-assigned if not provided)",
    )


class DocsServeResponse(BaseModel):
    """Response from dbt docs serve command."""

    success: bool
    message: str
    url: Optional[str] = None
    port: Optional[int] = None


class DocsStatusResponse(BaseModel):
    """Status of docs server for a project."""

    running: bool
    url: Optional[str] = None
    port: Optional[int] = None
    project_id: str
