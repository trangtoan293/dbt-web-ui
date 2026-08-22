"""Request and response models for the ingest API."""

from typing import List, Optional

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
