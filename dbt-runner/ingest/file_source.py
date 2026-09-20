"""Validate a filesystem ingest source: CSV, JSONL or Parquet under a fenced root.

The whole configuration is declarative - a directory, a glob and a format - for
the same reason a SQL source is a list of table names: dlt defines sources in
Python, and Python arriving in a request body is remote code execution.

A local path is fenced to INGEST_FILE_ROOTS, the same shape as an external
lakehouse's data path. dbt-runner can write anywhere its uid reaches, so
"any absolute path the user typed" would let one user read another's project
files, the storage volume, or /etc.

ponytail: local paths only. Object storage needs its own credential row and a
form to enter it; add it when someone actually ingests from S3, not before.
"""

import re
from pathlib import Path
from typing import Any, Dict, List

from app.config import settings
from ingest.hints import suggest_cursor
from ingest.preview import PREVIEW_ROW_LIMIT, jsonable

# What dlt can read here without pandas: CSV goes through duckdb, Parquet
# through pyarrow, JSONL through dlt's own reader. All three are already
# dependencies.
FORMATS = ("csv", "jsonl", "parquet")

# A glob, not a path: it is joined onto the fenced root, so it must not be able
# to climb out of it or start again from the filesystem root.
_GLOB_RE = re.compile(r"^[A-Za-z0-9_.*?/\[\]{}!-]{1,200}$")

_OBJECT_STORAGE = ("s3://", "gs://", "gcs://", "az://", "abfss://", "r2://")


class UnsupportedFileSource(ValueError):
    """Raised when a filesystem source's configuration is refused."""


def roots() -> list[Path]:
    raw = settings.ingest_file_roots or ""
    return [Path(r.strip()).resolve() for r in raw.split(",") if r.strip()]


def validate_bucket_url(raw: str) -> str:
    """Resolve a directory to read from, or refuse it.

    Returns a `file://` URL, which is what dlt's filesystem source takes.
    """
    candidate = (raw or "").strip()
    if not candidate:
        raise UnsupportedFileSource("a directory to read from is required")

    if candidate.lower().startswith(_OBJECT_STORAGE):
        raise UnsupportedFileSource(
            "object storage is not supported as an ingest source yet - it needs "
            "credentials of its own. Give a local path under one of the "
            "configured ingest roots."
        )

    if candidate.startswith("file://"):
        candidate = candidate[len("file://") :]

    allowed = roots()
    if not allowed:
        raise UnsupportedFileSource(
            "no ingest file roots are configured. Set INGEST_FILE_ROOTS to the "
            "mount points a filesystem source may read from."
        )

    resolved = Path(candidate).resolve()
    for root in allowed:
        if resolved == root or root in resolved.parents:
            return f"file://{resolved}"

    raise UnsupportedFileSource(
        f"'{raw}' is not under any configured ingest root "
        f"({', '.join(str(r) for r in allowed)})."
    )


def validate_glob(raw: str) -> str:
    glob = (raw or "").strip() or "*"
    if ".." in glob or glob.startswith("/"):
        raise UnsupportedFileSource(
            "the file pattern is relative to the directory above; it cannot start "
            "with '/' or contain '..'"
        )
    if not _GLOB_RE.match(glob):
        raise UnsupportedFileSource(f"'{raw}' is not a usable file pattern")
    return glob


def validate_format(raw: str) -> str:
    fmt = (raw or "").strip().lower()
    if fmt not in FORMATS:
        raise UnsupportedFileSource(
            f"format must be one of {', '.join(FORMATS)}, not '{raw}'"
        )
    return fmt


def preview_files(source_config: Dict[str, Any] | None) -> Dict[str, Any]:
    """Which files match, and what the first rows in them look like.

    Blocking - call it from a thread.

    The directory, glob and format go through the same validators the load
    itself uses, so a preview can never read somewhere a load could not. duckdb
    does the reading for all three formats: it is already in the image, it
    infers CSV types, and it is what the CSV loader uses at run time anyway.

    An empty directory is an answer, not an error. "No files match `*.csv` here"
    is the single most useful thing this call can tell someone, and raising
    would have turned it into a red box with a stack trace behind it.
    """
    config = source_config or {}
    directory = Path(validate_bucket_url(str(config.get("bucket_url") or ""))[len("file://") :])
    glob = validate_glob(str(config.get("file_glob") or ""))
    fmt = validate_format(str(config.get("format") or "csv"))

    matches = sorted(path for path in directory.glob(glob) if path.is_file())
    if not matches:
        return {"columns": [], "rows": [], "files": [], "suggested_cursor": None}

    import duckdb

    readers = {
        "csv": "read_csv_auto",
        "jsonl": "read_json_auto",
        "parquet": "read_parquet",
    }
    connection = duckdb.connect()
    try:
        # One bound parameter, never the path interpolated: the fence above says
        # *where* it may read, and the binding says it is data either way.
        cursor = connection.execute(
            f"SELECT * FROM {readers[fmt]}(?) LIMIT {PREVIEW_ROW_LIMIT}",
            [str(matches[0])],
        )
        names = [d[0] for d in cursor.description]
        types = [str(d[1]) for d in cursor.description]
        rows: List[Dict[str, Any]] = [
            {name: jsonable(value) for name, value in zip(names, record)}
            for record in cursor.fetchall()
        ]
    finally:
        connection.close()

    columns = [
        {"name": name, "type": type_, "nullable": True}
        for name, type_ in zip(names, types)
    ]
    return {
        "columns": columns,
        "rows": rows,
        # Relative: the absolute path is a server detail, and the fenced root is
        # not something the form should be teaching people to type.
        "files": [str(path.relative_to(directory)) for path in matches[:50]],
        "suggested_cursor": suggest_cursor(columns),
    }


def build_config(source_config: Dict[str, Any] | None, table: str) -> Dict[str, Any]:
    """The validated `source` block for a filesystem ingest job.

    `table` is where the files land: one source loads one directory into one
    table, because a glob that spanned several schemas would have no honest
    destination.
    """
    config = source_config or {}
    return {
        "type": "filesystem",
        "bucket_url": validate_bucket_url(str(config.get("bucket_url") or "")),
        "file_glob": validate_glob(str(config.get("file_glob") or "")),
        "format": validate_format(str(config.get("format") or "csv")),
        "table": table,
    }
