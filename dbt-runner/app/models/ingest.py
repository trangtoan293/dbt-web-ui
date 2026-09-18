"""Request and response models for the ingest API."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class IngestRunRequest(BaseModel):
    """Overrides for one run. Everything defaults to the stored source config."""

    tables: Optional[List[str]] = Field(
        default=None, description="Subset of the source's tables to load"
    )
    write_disposition: Optional[str] = Field(
        default=None, description="append | replace | merge"
    )
    full_refresh: bool = Field(
        default=False,
        description="Drop dlt's incremental state so the next load starts from scratch",
    )


class IngestTableList(BaseModel):
    success: bool
    tables: List[str] = []
    message: Optional[str] = None


class DbtSourcesSnippet(BaseModel):
    """Ready-to-paste dbt sources.yml for tables written by an ingest source."""

    success: bool
    dataset: str
    content: str


class RestProbeRequest(BaseModel):
    """One endpoint to fetch before a REST source is saved.

    The credential comes from a saved connection rather than the body: a probe
    must not be a way to post an API key to the server and have it forwarded.
    """

    connection_id: Optional[str] = Field(
        default=None, description="A `rest` connection carrying the credential"
    )
    base_url: Optional[str] = Field(
        default=None, description="Overrides the connection's base URL"
    )
    path: str = Field(default="", description="Endpoint path, relative to the base URL")
    params: Optional[Dict[str, Any]] = Field(
        default=None, description="Fixed query parameters, scalars only"
    )
