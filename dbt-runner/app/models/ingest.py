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


class IngestPreviewRequest(BaseModel):
    """One table (or one directory) to look at before the source is saved.

    Keyed on a connection the caller owns rather than on a stored source, for
    the same reason the table picker is: the whole point is to answer questions
    while the source is still being written.

    There is no row-count parameter. The cap is the server's - see
    `ingest/preview.py` - because a preview that could return everything is an
    export endpoint wearing a form helper's name.
    """

    source_type: str = Field(default="sql_database", description="sql_database | filesystem")
    connection_id: Optional[str] = Field(
        default=None, description="Connection to read through, for sql_database"
    )
    table: Optional[str] = Field(default=None, description="Source table, for sql_database")
    source_config: Optional[Dict[str, Any]] = Field(
        default=None, description="Directory, glob and format, for filesystem"
    )


class IngestPreview(BaseModel):
    """Columns and a handful of rows, plus what the form should fill in."""

    success: bool
    message: Optional[str] = None
    columns: List[Dict[str, Any]] = []
    rows: List[Dict[str, Any]] = []
    primary_key: List[str] = []
    suggested_cursor: Optional[str] = None
    suggested_write_disposition: Optional[str] = None
    files: List[str] = []


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
