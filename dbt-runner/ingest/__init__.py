"""Ingest: pull data from a configured Connection into a warehouse or lakehouse.

Mirrors the layout of `adapters/`: this module is the registry, the siblings hold
one concern each.

- `sql_source`   - Connection row -> SQLAlchemy URL for dlt to read
- `destination`  - where a job writes (project warehouse, or DuckLake)
- `lakehouse`    - DuckLake layout, shared with dbt profile generation
- `runner`       - `python -m ingest.runner`, one job per subprocess

Only declarative source configuration is accepted. dlt can define sources in
Python, which would be remote code execution the moment that Python came from a
request body, so source definitions here are table lists and nothing else.
"""

from ingest.destination import DESTINATIONS, build_destination
from ingest.sql_source import build_source_url, supported_source_types

# Source kinds a stored IngestSource may declare. `rest_api` is deliberately
# absent until the declarative REST config is wired up.
SOURCE_TYPES = ("sql_database",)

__all__ = [
    "DESTINATIONS",
    "SOURCE_TYPES",
    "build_destination",
    "build_source_url",
    "supported_source_types",
]
