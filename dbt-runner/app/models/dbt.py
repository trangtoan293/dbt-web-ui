"""
Pydantic models for dbt operations.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DbtCommand(BaseModel):
    """Request to execute a dbt command."""

    project_id: str = Field(..., description="Project identifier")
    command: str = Field(
        ..., description="dbt command (run, test, build, compile, etc.)"
    )
    selector: Optional[str] = Field(None, description="Model selector (--select)")
    flags: Optional[List[str]] = Field(None, description="Additional command flags")
    environment_variables: Optional[Dict[str, str]] = Field(
        None, description="Environment variables to expose to dbt for this run"
    )


class CompileRequest(BaseModel):
    """Request to compile a specific dbt model."""

    project_id: str = Field(..., description="Project identifier")
    model_path: str = Field(..., description="Path to the model file")
    additional_args: Optional[str] = Field(
        None, description="Additional dbt CLI arguments for dbt compile"
    )
    environment_variables: Optional[Dict[str, str]] = Field(
        None, description="Environment variables to expose to dbt for this compile"
    )


class PreviewRequest(BaseModel):
    """Request to preview model data using dbt show."""

    project_id: str = Field(..., description="Project identifier")
    model_path: str = Field(..., description="Path to the model file")
    limit: int = Field(100, ge=1, le=1000, description="Number of rows to preview")
    additional_args: Optional[str] = Field(
        None, description="Additional dbt CLI arguments for dbt show"
    )
    environment_variables: Optional[Dict[str, str]] = Field(
        None, description="Environment variables to expose to dbt for this preview"
    )


class ExplainRequest(BaseModel):
    """Request to explain a compiled dbt model query plan."""

    project_id: str = Field(..., description="Project identifier")
    model_path: str = Field(..., description="Path to the model file")
    additional_args: Optional[str] = Field(
        None, description="Additional dbt CLI arguments for dbt compile"
    )
    environment_variables: Optional[Dict[str, str]] = Field(
        None, description="Environment variables to expose to dbt for this explain"
    )


class QueryRequest(BaseModel):
    """Request to run a read-only inline SELECT via dbt show --inline."""

    project_id: str = Field(..., description="Project identifier")
    sql: str = Field(..., description="A single read-only SELECT statement")
    limit: int = Field(100, ge=1, le=1000, description="Max rows to return")
    environment_variables: Optional[Dict[str, str]] = Field(
        None, description="Environment variables to expose to dbt for this query"
    )


class LineageRequest(BaseModel):
    """Request to get data lineage for a model."""

    project_id: str = Field(..., description="Project identifier")
    model_path: str = Field(..., description="Path to the model file")


class DbtInitRequest(BaseModel):
    """Request to initialize a new dbt project from scratch."""

    project_id: str = Field(..., description="Project identifier")
    project_name: str = Field(..., description="Name for the new dbt project")


class DbtIntellisenseColumn(BaseModel):
    """Column metadata for dbt editor intellisense."""

    name: str
    data_type: Optional[str] = None
    description: Optional[str] = None


class DbtIntellisenseModel(BaseModel):
    """Model metadata for dbt editor intellisense."""

    name: str
    unique_id: str
    path: str
    description: Optional[str] = None
    columns: List[DbtIntellisenseColumn] = Field(default_factory=list)


class DbtIntellisenseSource(BaseModel):
    """Source metadata for dbt editor intellisense."""

    source_name: str
    table_name: str
    unique_id: str
    path: str
    description: Optional[str] = None
    columns: List[DbtIntellisenseColumn] = Field(default_factory=list)


class DbtIntellisenseMacro(BaseModel):
    """Macro metadata for dbt editor intellisense."""

    name: str
    package_name: Optional[str] = None
    unique_id: str
    path: str
    description: Optional[str] = None
    arguments: List[Dict[str, Any]] = Field(default_factory=list)


class DbtIntellisenseDoc(BaseModel):
    """Doc block metadata for dbt editor intellisense."""

    name: str
    unique_id: str
    path: str


class DbtIntellisenseResponse(BaseModel):
    """Normalized dbt metadata for Monaco autocomplete and definitions."""

    success: bool
    status: str
    generated_at: Optional[str] = None
    catalog_available: bool = False
    models: List[DbtIntellisenseModel] = Field(default_factory=list)
    sources: List[DbtIntellisenseSource] = Field(default_factory=list)
    macros: List[DbtIntellisenseMacro] = Field(default_factory=list)
    docs: List[DbtIntellisenseDoc] = Field(default_factory=list)
