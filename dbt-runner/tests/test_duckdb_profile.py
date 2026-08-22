import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapters.duckdb import DEFAULT_DB_FILE, DuckDBAdapter
from app.services.dbt_service import DbtService, _fix_in_memory_duckdb_profile


def _target(content):
    return yaml.safe_load(content)["proj"]["outputs"]["dev"]


def test_empty_path_becomes_project_local_file_not_memory():
    # ':memory:' would drop every model between dbt processes, so a ref to a
    # model built by an earlier run fails with "Table ... does not exist".
    for config in ({}, {"path": ""}, {"path": ":memory:"}, {"path": "memory"}):
        target = _target(DuckDBAdapter(config).generate_profiles_yml("proj"))
        assert target["path"] == DEFAULT_DB_FILE, config


def test_explicit_path_is_kept():
    target = _target(
        DuckDBAdapter({"path": "/data/storage/my.duckdb"}).generate_profiles_yml("proj")
    )
    assert target["path"] == "/data/storage/my.duckdb"


def test_placeholder_profile_is_not_in_memory():
    content = DbtService._placeholder_profiles_yml("proj")
    assert ":memory:" not in content
    assert _target(content) == {
        "type": "duckdb",
        "path": DEFAULT_DB_FILE,
        "schema": "main",
        "threads": 4,
    }


def test_existing_in_memory_profile_is_repointed(tmp_path):
    profiles = tmp_path / "profiles.yml"
    profiles.write_text(
        "proj:\n  target: dev\n  outputs:\n    dev:\n"
        "      type: duckdb\n      path: ':memory:'\n      schema: main\n      threads: 4\n"
    )

    _fix_in_memory_duckdb_profile(tmp_path)

    assert _target(profiles.read_text())["path"] == DEFAULT_DB_FILE


def test_untouched_when_no_profile_or_no_memory_target(tmp_path):
    _fix_in_memory_duckdb_profile(tmp_path)  # missing file: no crash
    profiles = tmp_path / "profiles.yml"
    original = (
        "proj:\n  target: dev\n  outputs:\n    dev:\n"
        "      type: postgres\n      host: db\n"
    )
    profiles.write_text(original)

    _fix_in_memory_duckdb_profile(tmp_path)

    assert profiles.read_text() == original
