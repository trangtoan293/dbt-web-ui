"""
Pydantic models for connection and profiles operations.
"""

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class DremioTestRequest(BaseModel):
    """Request to test Dremio connection (legacy)."""

    host: str = Field(..., description="Dremio host")
    port: int = Field(9047, description="Dremio REST API port")
    token: str = Field(..., description="Personal Access Token")
    catalog_name: Optional[str] = Field(None, description="Catalog name")


class ConnectionTestRequest(BaseModel):
    """Request to test any connection type using adapter pattern."""

    type: str = Field(..., description="Connection type (postgresql, duckdb, dremio)")
    name: str = Field(..., description="Connection name")
    config: Dict[str, Any] = Field(..., description="Connection configuration")


class ConnectionSchemaRequest(BaseModel):
    """Request to extract schema from a connection."""

    type: str = Field(..., description="Connection type")
    config: Dict[str, Any] = Field(..., description="Connection configuration")


