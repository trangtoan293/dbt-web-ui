"""A project pinned to the DuckLake catalog cannot run on another warehouse.

`+database: lake` survives a connection change, and dbt then asks Dremio (or
Postgres, or Oracle) for a catalog named `lake`. Every model fails with "not
found within 'lake'", which reads as the connection having reverted to DuckDB.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.routers.dbt import _lake_references


def _project(tmp_path: Path, dbt_project: str, sources: str | None = None) -> Path:
    (tmp_path / "dbt_project.yml").write_text(dbt_project)
    if sources is not None:
        models = tmp_path / "models" / "staging"
        models.mkdir(parents=True)
        (models / "sources.yml").write_text(sources)
    return tmp_path


PINNED = """
models:
  toant:
    +database: lake
    staging:
      +schema: staging
"""

UNPINNED = """
models:
  toant:
    staging:
      +schema: staging
"""

SOURCES = """
version: 2
sources:
  - name: raw_crm
    database: lake
    schema: raw_crm
"""


def test_finds_the_project_level_pin(tmp_path):
    assert _lake_references(_project(tmp_path, PINNED)) == ["dbt_project.yml"]


def test_finds_a_pin_in_a_sources_file(tmp_path):
    assert _lake_references(_project(tmp_path, UNPINNED, SOURCES)) == [
        "models/staging/sources.yml"
    ]


def test_quoted_and_unquoted_forms_both_count(tmp_path):
    assert _lake_references(_project(tmp_path, 'models:\n  x:\n    +database: "lake"\n'))


def test_a_project_naming_another_database_is_clean(tmp_path):
    assert _lake_references(_project(tmp_path, UNPINNED, SOURCES.replace("lake", "LakeHouse"))) == []


def test_a_lookalike_name_is_not_a_pin(tmp_path):
    """`lakehouse` is a different database; substring matching would flag it."""
    assert _lake_references(_project(tmp_path, "models:\n  x:\n    +database: lakehouse\n")) == []
