"""Rendering profiles.yml from a project's stored connection.

A configured connection that cannot be rendered must fail loudly: falling back
to the profiles.yml on disk (often the DuckDB placeholder) makes dbt run against
a different warehouse than the one the user attached.
"""
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapters.dremio import DremioAdapter
from app.exceptions import DbtOperationError
from app.services.dbt_service import (
    DbtService,
    build_adapter_config_from_connection_row,
)


class _FakeResult:
    def __init__(self, row=None, scalar=None):
        self._row = row
        self._scalar = scalar

    def mappings(self):
        return self

    def first(self):
        return self._row

    def all(self):
        return []

    def scalar(self):
        return self._scalar


class _FakeSession:
    """Returns the queued rows, one per row-returning execute() call.

    Feature-probe queries (`to_regclass`) are answered by shape rather than by
    position: they are asked before optional tables are read, and a positional
    queue would have to be re-numbered every time one is added.
    """

    def __init__(self, rows, has_optional_tables=False):
        self._rows = list(rows)
        self._has_optional_tables = has_optional_tables

    async def execute(self, statement, *_args, **_kwargs):
        if "to_regclass" in str(statement):
            return _FakeResult(scalar=self._has_optional_tables)
        return _FakeResult(row=self._rows.pop(0))


def _project(tmp_path, profile="proj"):
    (tmp_path / "dbt_project.yml").write_text(f"name: '{profile}'\nprofile: '{profile}'\n")
    return tmp_path


@pytest.mark.asyncio
async def test_deleted_connection_raises_instead_of_reusing_disk_profile(tmp_path):
    project_path = _project(tmp_path)
    stale = "proj:\n  outputs:\n    dev:\n      type: duckdb\n      path: dev.duckdb\n  target: dev\n"
    (project_path / "profiles.yml").write_text(stale)
    session = _FakeSession([
        {"connection_id": "11111111-1111-1111-1111-111111111111", "dremio_source_id": None},
        None,  # connection row is gone
    ])

    with pytest.raises(DbtOperationError):
        await DbtService._regenerate_profiles_from_db(session, "pid", project_path)

    assert (project_path / "profiles.yml").read_text() == stale  # untouched, not trusted


@pytest.mark.asyncio
async def test_configured_connection_overwrites_disk_profile(tmp_path):
    project_path = _project(tmp_path)
    session = _FakeSession([
        {"connection_id": "11111111-1111-1111-1111-111111111111", "dremio_source_id": None},
        {
            "connection_type": "postgresql",
            "host": "db",
            "port": 5432,
            "database": "warehouse",
            "username": "u",
            "password_encrypted": None,
            "extra_config": None,
        },
    ])

    await DbtService._regenerate_profiles_from_db(session, "pid", project_path)
    target = yaml.safe_load((project_path / "profiles.yml").read_text())["proj"]["outputs"]["dev"]
    assert target["type"] == "postgres" and target["dbname"] == "warehouse"


@pytest.mark.asyncio
async def test_project_without_connection_stays_silent(tmp_path):
    project_path = _project(tmp_path)
    session = _FakeSession([{"connection_id": None, "dremio_source_id": None}])

    assert await DbtService._regenerate_profiles_from_db(session, "pid", project_path) == {}


def test_explicit_dremio_space_survives_empty_user():
    output = yaml.safe_load(
        DremioAdapter({"host": "h", "port": 9047, "pat": "t", "dremio_space": "prod"})
        .generate_profiles_yml("proj")
    )["proj"]["outputs"]["dev"]
    assert output["dremio_space"] == "prod"


def test_target_schema_comes_from_extra_config():
    row = {
        "connection_type": "postgresql",
        "host": "db",
        "port": 5432,
        "database": "warehouse",
        "username": "u",
        "extra_config": {"schema": "analytics"},
    }
    _, config, _ = build_adapter_config_from_connection_row(row)
    assert config["schema"] == "analytics"

    row["extra_config"] = None
    _, config, _ = build_adapter_config_from_connection_row(row)
    assert config["schema"] == "public"


def test_unsupported_connection_type_is_rejected():
    with pytest.raises(ValueError, match="snowflake"):
        build_adapter_config_from_connection_row(
            {"connection_type": "snowflake", "extra_config": {}}
        )
