"""
Data Lineage Module for dbt-runner.

Uses dbt manifest.json for table-level lineage and sqlglot for column-level lineage.
"""

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

# Conditional import for sqlglot
SQLGLOT_AVAILABLE = False

try:
    from sqlglot import parse_one
    from sqlglot.lineage import lineage

    SQLGLOT_AVAILABLE = True
except ImportError:
    pass


@dataclass
class LineageNode:
    """Represents a node in the lineage graph."""

    id: str
    name: str
    type: str  # 'model', 'source', 'seed', 'snapshot'
    schema: Optional[str] = None
    database: Optional[str] = None
    position: Optional[str] = None  # 'upstream', 'current', 'downstream'
    columns: Optional[List[str]] = None


@dataclass
class LineageEdge:
    """Represents an edge (dependency) in the lineage graph."""

    from_node: str
    to_node: str


@dataclass
class ColumnLineage:
    """Represents column-level lineage information."""

    column: str
    source_column: str
    source_table: str
    transformation: Optional[str] = None


def parse_manifest(manifest_path: Path) -> Dict[str, Any]:
    """Load and parse dbt manifest.json."""
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest_path}")

    with open(manifest_path, "r") as f:
        return json.load(f)


def get_node_type(node_id: str) -> str:
    """Extract node type from dbt node ID."""
    # Format: model.project.name, source.project.name, seed.project.name
    parts = node_id.split(".")
    if parts:
        return parts[0]
    return "unknown"


def get_node_name(node_id: str) -> str:
    """Extract node name from dbt node ID."""
    parts = node_id.split(".")
    if len(parts) >= 3:
        return parts[-1]
    return node_id


def get_table_lineage(manifest: Dict[str, Any], model_name: str) -> Dict[str, Any]:
    """
    Extract table-level lineage from dbt manifest.

    Returns upstream dependencies, current model, and downstream dependents.
    """
    nodes: List[LineageNode] = []
    edges: List[LineageEdge] = []

    # Find the current model
    current_node_id = None
    for node_id, node_data in manifest.get("nodes", {}).items():
        if node_data.get("name") == model_name:
            current_node_id = node_id
            break

    if not current_node_id:
        # Also check sources
        for source_id, source_data in manifest.get("sources", {}).items():
            if source_data.get("name") == model_name:
                current_node_id = source_id
                break

    if not current_node_id:
        return {
            "nodes": [],
            "edges": [],
            "error": f"Model '{model_name}' not found in manifest",
        }

    current_data = manifest["nodes"].get(current_node_id) or manifest.get(
        "sources", {}
    ).get(current_node_id, {})

    # Add current node
    current_node = LineageNode(
        id=current_node_id,
        name=model_name,
        type=get_node_type(current_node_id),
        schema=current_data.get("schema"),
        database=current_data.get("database"),
        position="current",
        columns=list(current_data.get("columns", {}).keys()) or None,
    )
    nodes.append(current_node)

    # Get upstream dependencies
    depends_on = current_data.get("depends_on", {}).get("nodes", [])
    for dep_id in depends_on:
        dep_data = manifest["nodes"].get(dep_id) or manifest.get("sources", {}).get(
            dep_id, {}
        )
        if dep_data:
            upstream_node = LineageNode(
                id=dep_id,
                name=get_node_name(dep_id),
                type=get_node_type(dep_id),
                schema=dep_data.get("schema"),
                database=dep_data.get("database"),
                position="upstream",
                columns=list(dep_data.get("columns", {}).keys()) or None,
            )
            nodes.append(upstream_node)
            # Edges reference node IDs (not names) so the frontend can match them
            # against node positions, which are keyed by node.id.
            edges.append(LineageEdge(from_node=dep_id, to_node=current_node_id))

    # Get downstream dependents (models that depend on this model)
    child_map = manifest.get("child_map", {})
    downstream_ids = child_map.get(current_node_id, [])
    for child_id in downstream_ids:
        child_data = manifest["nodes"].get(child_id, {})
        if child_data and child_data.get("resource_type") == "model":
            downstream_node = LineageNode(
                id=child_id,
                name=get_node_name(child_id),
                type=get_node_type(child_id),
                schema=child_data.get("schema"),
                database=child_data.get("database"),
                position="downstream",
                columns=list(child_data.get("columns", {}).keys()) or None,
            )
            nodes.append(downstream_node)
            edges.append(LineageEdge(from_node=current_node_id, to_node=child_id))

    return {
        "nodes": [asdict(n) for n in nodes],
        "edges": [{"from": e.from_node, "to": e.to_node} for e in edges],
    }


def _leaf_sources(node: Any) -> List[Dict[str, str]]:
    """Walk a sqlglot lineage Node to its leaves and return source columns.

    Leaf node names are table-qualified (e.g. ``raw_orders.id``). The leaf is
    the ultimate origin of the output column.
    """
    sources: List[Dict[str, str]] = []
    seen: set = set()

    def walk(n: Any) -> None:
        if not n.downstream:
            name = n.name or ""
            # Split "schema.table.column" / "table.column" -> table, column
            if "." in name:
                table, column = name.rsplit(".", 1)
            else:
                table, column = "unknown", name
            key = (table, column)
            if column and key not in seen:
                seen.add(key)
                sources.append(
                    {
                        "column": column,
                        "table": table,
                        "expression": str(n.expression)[:150] if n.expression else "",
                    }
                )
            return
        for child in n.downstream:
            walk(child)

    walk(node)
    return sources


def get_column_lineage(
    compiled_sql: str,
    schema: Optional[Dict[str, Dict[str, str]]] = None,
    dialect: str = "duckdb",
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Analyze column-level lineage using sqlglot's built-in lineage engine.

    Args:
        compiled_sql: The compiled SQL query
        schema: Optional schema dict mapping table names to column definitions.
            Required to expand ``SELECT *`` and disambiguate multi-table joins.
        dialect: SQL dialect to parse with.

    Returns:
        Dict mapping each output column to its ultimate source columns.
    """
    if not SQLGLOT_AVAILABLE:
        return {"error": "sqlglot not available"}  # type: ignore[dict-item]

    try:
        parsed = parse_one(compiled_sql, dialect=dialect)
        output_columns = parsed.named_selects
    except Exception as e:
        return {"error": f"Failed to parse SQL: {str(e)}"}  # type: ignore[dict-item]

    if not output_columns:
        return {"error": "No output columns found"}  # type: ignore[dict-item]

    column_lineage: Dict[str, List[Dict[str, Any]]] = {}
    for output_col in output_columns:
        try:
            node = lineage(output_col, compiled_sql, schema=schema, dialect=dialect)
            column_lineage[output_col] = _leaf_sources(node)
        except Exception as e:
            column_lineage[output_col] = [
                {
                    "column": output_col,
                    "table": "unknown",
                    "expression": f"Failed to trace lineage: {str(e)}",
                }
            ]

    return column_lineage


def get_full_lineage(project_path: Path, model_name: str) -> Dict[str, Any]:
    """
    Get complete lineage information for a model.

    Combines table lineage from manifest and column lineage from compiled SQL.
    """
    target_path = project_path / "target"
    manifest_path = target_path / "manifest.json"

    result = {
        "success": False,
        "model": model_name,
        "table_lineage": {"nodes": [], "edges": []},
        "column_lineage": {},
    }

    # Get table lineage from manifest
    if manifest_path.exists():
        try:
            manifest = parse_manifest(manifest_path)
            table_lineage = get_table_lineage(manifest, model_name)
            result["table_lineage"] = table_lineage
            if table_lineage.get("error"):
                # Model missing from manifest (usually a stale manifest:
                # model was created/renamed but not recompiled).
                result["error"] = (
                    f"{table_lineage['error']}. Run 'dbt compile' to refresh lineage."
                )
            else:
                result["success"] = True
        except Exception as e:
            result["error"] = f"Failed to parse manifest: {str(e)}"
    else:
        result["error"] = "manifest.json not found. Run 'dbt compile' first."
        return result

    # Get column lineage from compiled SQL
    compiled_path = target_path / "compiled"
    if compiled_path.exists():
        # Find compiled SQL file for the model
        for sql_file in compiled_path.rglob(f"{model_name}.sql"):
            try:
                compiled_sql = sql_file.read_text()

                # Build schema from manifest columns
                schema = {}
                manifest_relations = {
                    **manifest.get("nodes", {}),
                    **manifest.get("sources", {}),
                }
                for node_id, node_data in manifest_relations.items():
                    if node_data.get("columns"):
                        columns = {
                            col_name: col_data.get("data_type", "unknown")
                            for col_name, col_data in node_data["columns"].items()
                        }
                        relation_names = {
                            node_data.get("name"),
                            node_data.get("identifier"),
                            get_node_name(node_id),
                        }
                        for table_name in filter(None, relation_names):
                            schema[table_name] = columns

                result["column_lineage"] = get_column_lineage(compiled_sql, schema)
            except Exception as e:
                result["column_lineage"] = {"error": str(e)}
            break

    return result
