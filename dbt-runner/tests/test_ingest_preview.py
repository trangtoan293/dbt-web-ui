"""What the wizard can show about a table *before* the load is saved.

The reason this exists: the cursor field is the most important thing on an
ingest source, and until now the only way to fill it in was to remember a column
name. These are the calls that let the form propose one and show the rows it was
proposed from.

SQLite source and a CSV on disk - no running services.
"""

import csv
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ingest import file_source
from ingest.hints import suggest_cursor
from ingest.sql_source import PREVIEW_ROW_LIMIT, preview_table


# --- cursor guessing -------------------------------------------------------


def _col(name: str, type_: str = "TIMESTAMP"):
    return {"name": name, "type": type_, "nullable": True}


def test_prefers_an_update_timestamp_over_a_creation_one():
    columns = [_col("created_at"), _col("updated_at")]
    assert suggest_cursor(columns) == "updated_at"


def test_matches_a_hint_regardless_of_case_or_suffix():
    assert suggest_cursor([_col("LAST_MODIFIED", "TIMESTAMP(6)")]) == "LAST_MODIFIED"
    assert suggest_cursor([_col("modified", "DATETIME")]) == "modified"


def test_ignores_a_hinted_name_that_is_not_a_date():
    """`updated_by` is a person, not a clock."""
    assert suggest_cursor([_col("updated_by", "VARCHAR(50)")]) is None


def test_does_not_guess_from_an_unhinted_date_column():
    """A birth date is a date column and a catastrophic cursor."""
    assert suggest_cursor([_col("birth_date", "DATE"), _col("id", "INTEGER")]) is None


def test_no_columns_means_no_guess():
    assert suggest_cursor([]) is None


# --- SQL preview -----------------------------------------------------------


@pytest.fixture
def source_db(tmp_path: Path) -> str:
    path = tmp_path / "preview.sqlite"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE customers ("
        "  cust_id INTEGER PRIMARY KEY,"
        "  full_name TEXT NOT NULL,"
        "  updated_at TIMESTAMP,"
        "  opened_on DATE"
        ")"
    )
    connection.executemany(
        "INSERT INTO customers VALUES (?, ?, ?, ?)",
        [(i, f"Customer {i}", f"2026-09-0{i % 9 + 1}", "2019-03-02") for i in range(25)],
    )
    connection.commit()
    connection.close()
    return f"sqlite:///{path}"


def test_preview_returns_columns_primary_key_and_a_capped_sample(source_db: str):
    preview = preview_table(source_db, "customers")

    assert [c["name"] for c in preview["columns"]] == [
        "cust_id",
        "full_name",
        "updated_at",
        "opened_on",
    ]
    assert preview["primary_key"] == ["cust_id"]
    assert preview["suggested_cursor"] == "updated_at"
    assert len(preview["rows"]) == PREVIEW_ROW_LIMIT
    assert preview["rows"][0]["full_name"] == "Customer 0"


def test_preview_never_returns_more_than_the_server_cap(source_db: str):
    """The row count is not the caller's to choose: this endpoint is a glance."""
    assert len(preview_table(source_db, "customers", limit=10_000)["rows"]) == PREVIEW_ROW_LIMIT


def test_preview_rows_are_json_safe(source_db: str):
    import json

    json.dumps(preview_table(source_db, "customers"))


def test_preview_of_a_missing_table_raises(source_db: str):
    with pytest.raises(Exception):
        preview_table(source_db, "no_such_table")


# --- file preview ----------------------------------------------------------


@pytest.fixture
def csv_dir(tmp_path: Path, monkeypatch) -> Path:
    from app.config import settings

    directory = tmp_path / "drop"
    directory.mkdir()
    with open(directory / "day1.csv", "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["id", "name", "modified_at"])
        for i in range(20):
            writer.writerow([i, f"row {i}", f"2026-09-{i % 28 + 1:02d}"])
    monkeypatch.setattr(settings, "ingest_file_roots", str(tmp_path))
    return directory


def test_file_preview_reads_columns_and_rows(csv_dir: Path):
    preview = file_source.preview_files(
        {"bucket_url": str(csv_dir), "file_glob": "*.csv", "format": "csv"}
    )
    assert [c["name"] for c in preview["columns"]] == ["id", "name", "modified_at"]
    assert len(preview["rows"]) == PREVIEW_ROW_LIMIT
    assert preview["files"] == ["day1.csv"]


def test_file_preview_refuses_a_directory_outside_the_fenced_roots(csv_dir: Path):
    with pytest.raises(file_source.UnsupportedFileSource):
        file_source.preview_files(
            {"bucket_url": "/etc", "file_glob": "*.csv", "format": "csv"}
        )


def test_file_preview_reports_an_empty_directory_rather_than_failing(
    tmp_path: Path, monkeypatch
):
    from app.config import settings

    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setattr(settings, "ingest_file_roots", str(tmp_path))
    preview = file_source.preview_files(
        {"bucket_url": str(empty), "file_glob": "*.csv", "format": "csv"}
    )
    assert preview["files"] == []
    assert preview["rows"] == []
    assert preview["columns"] == []
