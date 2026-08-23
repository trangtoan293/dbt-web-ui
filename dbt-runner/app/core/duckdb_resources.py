"""DuckDB engine resource limits for generated dbt profiles.

DuckDB is this application's query engine: every dbt run is its own process with
its own DuckDB instance, and DuckLake reads Parquet through that same engine.
Left unconfigured DuckDB sizes itself at roughly 80% of the memory it can see
and uses every core - correct for one process on a laptop, wrong here.
`MAX_CONCURRENT_DBT_RUNS` processes each claiming 80% of the box over-commit it
by that factor, and the kernel then OOM-kills a run mid-flight instead of
DuckDB spilling to disk, which is what it does when a limit is set.

So each run is given an explicit share of the memory this container is actually
allowed, and spill is pointed at the volume sized for data rather than
`<db file>.tmp` beside the project.

These values are rendered into profiles.yml as a `settings:` block. Adapters
import nothing from `app`, so the numbers are computed here and passed in.
"""

import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from app.config import settings

logger = logging.getLogger(__name__)

# Headroom left to everything else in the container: uvicorn, the scheduler, and
# the resident memory of warm workers parked between jobs - bounded by
# DBT_WARM_WORKER_MAX_PROJECTS, or they grow with every project ever touched.
_MEMORY_HEADROOM = 0.75

# Below this a limit is worse than none: DuckDB would refuse to run even trivial
# queries, so a box this small is left to DuckDB's own sizing.
_MIN_LIMIT_MB = 256

# cgroup v1 writes a sentinel close to 2^63 for "no limit"; anything above the
# machine's own RAM is not a limit either way.
_CGROUP_V2 = Path("/sys/fs/cgroup/memory.max")
_CGROUP_V1 = Path("/sys/fs/cgroup/memory/memory.limit_in_bytes")


def _host_memory_bytes() -> Optional[int]:
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def _cgroup_memory_bytes() -> Optional[int]:
    """The container's own memory ceiling, or None when it is unlimited."""
    for path in (_CGROUP_V2, _CGROUP_V1):
        try:
            raw = path.read_text().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            value = int(raw)
        except ValueError:
            continue
        if value <= 0:
            continue
        return value
    return None


def available_memory_bytes() -> Optional[int]:
    """Memory this process may actually use, cgroup limit first.

    Reading the host's RAM inside a container with a `mem_limit` would size every
    run against memory the kernel will not hand out.
    """
    host = _host_memory_bytes()
    cgroup = _cgroup_memory_bytes()
    if cgroup is not None and (host is None or cgroup < host):
        return cgroup
    return host


def concurrent_engine_slots() -> int:
    """How many DuckDB instances may be doing work at once.

    Runs, ingest loads and console queries are what put a DuckDB instance to
    work, and each is capped by a Redis semaphore. Warm workers are *not*
    counted: a warm worker is a parked dbt process, and the moment it does
    anything it does it as a run or as a query, so it already holds one of these
    slots. What a parked worker costs is resident memory - that is what the
    headroom above is for, and what the pool's idle eviction bounds.

    Dividing by runs alone, which is what this did first, left console queries
    uncounted: an inline query took only a per-project lock, so N projects
    querying at once meant N instances each entitled to a full run's share, and
    the per-instance limit stopped bounding the machine.
    """
    return max(1, settings.max_concurrent_dbt_runs) + max(
        0, settings.max_concurrent_queries
    )


def memory_limit_per_run() -> Optional[str]:
    """DuckDB `memory_limit` for one engine slot, as a value DuckDB parses.

    An explicit DUCKDB_MEMORY_LIMIT wins. Otherwise the container's memory is
    split between the slots that may be in flight at once, so the concurrency
    ceilings and the memory ceiling cannot disagree.

    One value for runs and queries alike: they share profiles.yml, so there is
    nowhere to render two different limits without two writers racing on one
    file.
    """
    configured = (settings.duckdb_memory_limit or "").strip()
    if configured:
        return configured

    total = available_memory_bytes()
    if not total:
        logger.debug("Could not determine available memory; leaving DuckDB unbounded")
        return None

    slots = concurrent_engine_slots()
    megabytes = int(total * _MEMORY_HEADROOM / slots / (1024 * 1024))
    if megabytes < _MIN_LIMIT_MB:
        return None
    return f"{megabytes}MB"


def _safe_project_segment(project_id: Optional[str]) -> Optional[str]:
    if not project_id:
        return None
    candidate = str(project_id).strip()
    try:
        return str(uuid.UUID(candidate))
    except (ValueError, AttributeError, TypeError):
        logger.warning("Invalid project_id for DuckDB temp directory: %r", project_id)
        return None


def temp_directory(project_id: Optional[str] = None) -> str:
    """Spill directory, on the volume sized for data.

    Per project: DuckDB names temp files by handle, not by pid, so two processes
    sharing one directory can collide. The project is already the unit that owns
    a DuckDB file, so it is the unit that owns the spill too.
    """
    base = settings.duckdb_temp_dir or str(Path(settings.storage_dir) / "duckdb-tmp")
    safe_project_id = _safe_project_segment(project_id)
    return str(Path(base) / safe_project_id) if safe_project_id else base


def profile_settings(project_id: Optional[str] = None) -> Dict[str, Any]:
    """The `settings:` block for a generated DuckDB dbt profile.

    Only keys with a value are returned: an empty `settings:` block is noise, and
    passing None through to DuckDB is an error rather than a default.
    """
    values: Dict[str, Any] = {}

    limit = memory_limit_per_run()
    if limit:
        values["memory_limit"] = limit

    if settings.duckdb_threads > 0:
        values["threads"] = settings.duckdb_threads

    directory = temp_directory(project_id)
    if directory:
        # DuckDB does not create a missing temp_directory, it fails the query
        # that first needs to spill - which is the largest query, hours in.
        try:
            Path(directory).mkdir(parents=True, exist_ok=True)
            values["temp_directory"] = directory
        except OSError as exc:
            logger.warning("Cannot use %s as DuckDB spill directory: %s", directory, exc)

    max_temp = (settings.duckdb_max_temp_size or "").strip()
    if max_temp:
        values["max_temp_directory_size"] = max_temp

    if (settings.duckdb_preserve_insertion_order or "").strip().lower() == "false":
        # Only emitted when switched off: DuckDB's own default is true, and
        # writing false when nobody asked would silently reorder model output.
        values["preserve_insertion_order"] = False

    return values
