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
    target = _target(content)
    assert target["type"] == "duckdb"
    assert target["path"] == DEFAULT_DB_FILE
    assert target["schema"] == "main"
    assert target["threads"] == 4


def test_generated_profile_bounds_the_engine():
    # An unset memory_limit lets each dbt run claim ~80% of the box, so
    # MAX_CONCURRENT_DBT_RUNS of them over-commit it and one gets OOM-killed
    # rather than spilling. Every generated DuckDB profile must carry a limit.
    settings_block = _target(DbtService._placeholder_profiles_yml("proj"))["settings"]
    assert settings_block["memory_limit"].endswith("MB")
    # And spill must not default to `<db file>.tmp` inside the project volume.
    assert settings_block["temp_directory"]


def test_engine_settings_are_rendered_as_a_nested_block():
    target = _target(
        DuckDBAdapter(
            {"path": "x.duckdb", "settings": {"memory_limit": "8GB", "threads": 2}}
        ).generate_profiles_yml("proj")
    )
    assert target["settings"] == {"memory_limit": "8GB", "threads": 2}


def test_no_settings_key_when_there_is_nothing_to_set():
    # dbt-duckdb treats an empty `settings:` as a value, not as absence.
    assert "settings" not in _target(
        DuckDBAdapter({"path": "x.duckdb"}).generate_profiles_yml("proj")
    )


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
