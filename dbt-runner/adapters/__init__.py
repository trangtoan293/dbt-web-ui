"""
Connection adapter factory and exports.
"""
from typing import Any, Dict

from .base import BaseAdapter, Column, Table
from .postgresql import PostgreSQLAdapter
from .duckdb import DuckDBAdapter
from .dremio import DremioAdapter
from .oracle import OracleAdapter
from .spark import SparkAdapter

# Every adapter here has its dbt plugin bundled in the dbt-runner image
# (dbt-spark installs via the INSTALL_DBT_SPARK build arg). Keep this registry
# and the connection form in the UI in step: offering a warehouse the image
# cannot run only produces failed runs.
ADAPTERS: Dict[str, type] = {
    "postgresql": PostgreSQLAdapter,
    "duckdb": DuckDBAdapter,
    "dremio": DremioAdapter,
    "oracle": OracleAdapter,
    "spark": SparkAdapter,
}


def get_adapter(conn_type: str, config: Dict[str, Any]) -> BaseAdapter:
    """Instantiate the adapter for a connection type.

    Raises:
        ValueError: if the connection type has no adapter.
    """
    adapter_class = ADAPTERS.get(conn_type)
    if not adapter_class:
        supported = ", ".join(ADAPTERS)
        raise ValueError(f"Unsupported connection type: {conn_type}. Supported: {supported}")
    return adapter_class(config)


def list_adapters() -> Dict[str, str]:
    """List available adapter types with their class names."""
    return {name: cls.__name__ for name, cls in ADAPTERS.items()}


__all__ = [
    "BaseAdapter",
    "Column",
    "Table",
    "PostgreSQLAdapter",
    "DuckDBAdapter",
    "DremioAdapter",
    "OracleAdapter",
    "SparkAdapter",
    "get_adapter",
    "list_adapters",
    "ADAPTERS",
]
