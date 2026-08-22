"""The DuckLake attach block that dbt needs, rendered into profiles.yml.

This is the seam where ingest and dbt meet. If the attach block is missing, or
points at a different metadata schema than the runner wrote to, dbt fails with
`schema ... does not exist` after an ingest that reported success.
"""

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapters.duckdb import DuckDBAdapter
from ingest import lakehouse

PROJECT_ID = "3f8b1c2d-0000-4000-8000-abcdefabcdef"
CATALOG_URL = "postgresql://lake_user:s3cret@postgres:5432/dbtcraft"


@pytest.fixture
def lake_settings(tmp_path):
    with patch.object(lakehouse, "settings") as settings:
        settings.lake_catalog_url = CATALOG_URL
        settings.lake_data_dir = str(tmp_path / "lake")
        settings.storage_dir = str(tmp_path)
        settings.lake_inline_row_limit = 0
        yield settings


def test_attach_entry_matches_what_the_runner_writes(lake_settings):
    entry = lakehouse.dbt_attach_entry(PROJECT_ID)
    assert entry["options"]["metadata_schema"] == lakehouse.metadata_schema(PROJECT_ID)
    assert entry["options"]["data_path"] == f"{lakehouse.data_dir(PROJECT_ID)}/"
    assert entry["is_ducklake"] is True
    assert entry["alias"] == lakehouse.ATTACH_ALIAS


def test_catalog_password_never_appears_in_the_attach_path(lake_settings):
    entry = lakehouse.dbt_attach_entry(PROJECT_ID)
    assert "s3cret" not in entry["path"]
    assert lakehouse.CATALOG_PASSWORD_ENV in entry["path"]
    # ...but it is still available to hand to dbt through the environment.
    assert lakehouse.catalog_password() == "s3cret"


def test_profiles_yml_with_attach_block_is_valid_yaml(lake_settings):
    entry = lakehouse.dbt_attach_entry(PROJECT_ID)
    adapter = DuckDBAdapter(
        {
            "path": "/data/storage/dbt-projects/p/dev.duckdb",
            "schema": "main",
            "threads": 4,
            "extensions": list(lakehouse.DUCKDB_EXTENSIONS),
            "attach": [entry],
            "database": lakehouse.ATTACH_ALIAS,
        }
    )
    rendered = yaml.safe_load(adapter.generate_profiles_yml("my_project"))
    output = rendered["my_project"]["outputs"]["dev"]

    assert output["type"] == "duckdb"
    assert output["database"] == lakehouse.ATTACH_ALIAS
    assert set(lakehouse.DUCKDB_EXTENSIONS).issubset(output["extensions"])
    attached = output["attach"][0]
    assert attached["alias"] == lakehouse.ATTACH_ALIAS
    assert attached["options"]["metadata_schema"] == lakehouse.metadata_schema(
        PROJECT_ID
    )


def test_profiles_yml_without_a_lake_is_unchanged(lake_settings):
    """A project with no ingest source must not gain an attach block."""
    adapter = DuckDBAdapter({"path": "/tmp/dev.duckdb", "schema": "main", "threads": 4})
    output = yaml.safe_load(adapter.generate_profiles_yml("plain"))["plain"]["outputs"][
        "dev"
    ]
    assert "attach" not in output
    assert "database" not in output


def test_sqlite_catalog_is_supported(tmp_path):
    """The smallest deployments can keep the catalog in a file, no Postgres."""
    with patch.object(lakehouse, "settings") as settings:
        settings.lake_catalog_url = f"sqlite:///{tmp_path}/catalog.sqlite"
        settings.lake_data_dir = str(tmp_path / "lake")
        settings.storage_dir = str(tmp_path)
        path = lakehouse.dbt_attach_entry(PROJECT_ID)["path"]
    assert path == f"ducklake:sqlite:{tmp_path}/catalog.sqlite"


def test_unsupported_catalog_scheme_is_refused(tmp_path):
    with patch.object(lakehouse, "settings") as settings:
        settings.lake_catalog_url = "mysql://user:pw@host/db"
        settings.lake_data_dir = str(tmp_path)
        settings.storage_dir = str(tmp_path)
        with pytest.raises(lakehouse.LakehouseError):
            lakehouse.dbt_attach_entry(PROJECT_ID)


def test_empty_lake_catalog_url_falls_back_to_the_app_database(tmp_path):
    """docker-compose passes LAKE_CATALOG_URL as "" when it is unset.

    pydantic-settings honours that empty string, so the fallback cannot live in
    the Settings default - a lakehouse would silently report itself unconfigured
    in every default deployment.
    """
    with patch.object(lakehouse, "settings") as settings:
        settings.lake_catalog_url = ""
        settings.database_url = CATALOG_URL
        settings.lake_data_dir = str(tmp_path)
        settings.storage_dir = str(tmp_path)
        assert lakehouse.is_configured()
        assert lakehouse.catalog_url() == CATALOG_URL


def test_no_catalog_at_all_is_not_configured(tmp_path):
    with patch.object(lakehouse, "settings") as settings:
        settings.lake_catalog_url = ""
        settings.database_url = ""
        assert not lakehouse.is_configured()
        with pytest.raises(lakehouse.LakehouseError):
            lakehouse.catalog_url()
