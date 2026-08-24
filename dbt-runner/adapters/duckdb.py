"""
DuckDB adapter - mirrors duckdb.extractor.ts
Uses duckdb library for embedded analytics database.
"""
import os
from pathlib import Path
from typing import Dict, Any, List, Optional
from .base import BaseAdapter, Column, Table

# Default DuckDB file, relative to the dbt project dir (dbt always runs with
# cwd = project dir). Every dbt command is a separate process, so ':memory:'
# throws away every model as soon as the run ends and the next run fails with
# "Catalog Error: Table with name X does not exist". Never put ':memory:' in a
# generated profiles.yml.
DEFAULT_DB_FILE = "dev.duckdb"


class DuckDBAdapter(BaseAdapter):
    """
    DuckDB database adapter.
    
    Config structure:
    {
        "path": "/path/to/database.duckdb",  # or ":memory:"
        "schema": "main",                     # optional, default "main"
        "extensions": ["httpfs", "parquet"], # optional extensions to load
        "threads": 4,                         # optional, dbt model concurrency
        "settings": {"memory_limit": "8GB"}   # optional, DuckDB engine limits
    }
    """
    
    adapter_type = "duckdb"
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self._conn: Optional[Any] = None
        # Normalize path - handle None, empty string, or memory variations
        raw_path = config.get("path") or config.get("file_path")
        if not raw_path or raw_path in ("memory", ":memory:", "memory:", "null", "None", ""):
            self._path = ":memory:"
        else:
            self._path = str(raw_path)
        self._schema = config.get("schema", "main")
    
    @staticmethod
    def validate_db_file(path: str) -> Dict[str, Any]:
        """
        Validate DuckDB file integrity.
        
        Args:
            path: Path to DuckDB file
            
        Returns:
            Dict with 'valid' (bool), 'reason' (str), 'can_delete' (bool)
        """
        if path == ":memory:":
            return {"valid": True, "reason": "In-memory database", "can_delete": False}
        
        if not os.path.exists(path):
            return {"valid": True, "reason": "File doesn't exist yet (will be created)", "can_delete": False}
        
        # Check if file is empty or very small (likely corrupted)
        file_size = os.path.getsize(path)
        if file_size < 100:  # DuckDB files are at least a few KB
            return {
                "valid": False,
                "reason": f"File is too small ({file_size} bytes) to be a valid DuckDB database",
                "can_delete": True,
                "path": path
            }
        
        # Try to open and query the file
        import duckdb
        try:
            conn = duckdb.connect(path, read_only=True)
            # Simple query to verify database is valid
            conn.execute("SELECT 1").fetchone()
            conn.close()
            return {"valid": True, "reason": "Database file is valid", "can_delete": False}
        except Exception as e:
            error_msg = str(e)
            return {
                "valid": False,
                "reason": f"Database file is corrupted: {error_msg}",
                "can_delete": True,
                "path": path
            }
    
    async def connect(self) -> None:
        """Create DuckDB connection."""
        import duckdb
        self._conn = duckdb.connect(self._path)
        
        # Load extensions if specified
        extensions = self.config.get("extensions", [])
        for ext in extensions:
            try:
                self._conn.execute(f"INSTALL {ext}")
                self._conn.execute(f"LOAD {ext}")
            except Exception:
                pass  # Extension might already be loaded
    
    async def disconnect(self) -> None:
        """Close DuckDB connection."""
        if self._conn:
            self._conn.close()
            self._conn = None
    
    async def test_connection(self) -> Dict[str, Any]:
        """Test DuckDB connection with file integrity validation."""
        import duckdb
        
        # First validate file integrity if it's a file-based database
        if self._path != ":memory:":
            validation = self.validate_db_file(self._path)
            if not validation["valid"]:
                return {
                    "success": False,
                    "message": f"Database file validation failed: {validation['reason']}",
                    "details": {
                        "corrupted": True,
                        "can_delete": validation.get("can_delete", False),
                        "path": self._path,
                        "suggestion": "Delete the corrupted file and let dbt recreate it" if validation.get("can_delete") else None
                    }
                }
        
        try:
            conn = duckdb.connect(self._path)
            result = conn.execute("SELECT version() as version").fetchone()
            version = result[0] if result else "Unknown"
            conn.close()
            
            return {
                "success": True,
                "message": f"Connected to DuckDB",
                "details": {
                    "version": version,
                    "path": self._path,
                    "type": "in-memory" if self._path == ":memory:" else "file"
                }
            }
        except Exception as e:
            error_msg = str(e)
            # Check if error is related to file corruption
            is_corruption = "not a valid DuckDB database" in error_msg or "IO Error" in error_msg
            return {
                "success": False,
                "message": error_msg,
                "details": {
                    "corrupted": is_corruption,
                    "can_delete": is_corruption and self._path != ":memory:",
                    "path": self._path if self._path != ":memory:" else None,
                    "suggestion": f"Delete the file '{self._path}' and run 'dbt run' to recreate it" if is_corruption else None
                }
            }
    
    async def _get_schemas(self) -> List[str]:
        """Get all schemas in DuckDB."""
        if self._conn is None:
            raise RuntimeError("Database connection not initialized. Call connect() first.")
        try:
            result = self._conn.execute("""
                SELECT schema_name 
                FROM information_schema.schemata
                WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
            """).fetchall()
            return [row[0] for row in result]
        except Exception:
            return [self._schema]
    
    async def _get_tables(self, schema: str) -> List[str]:
        """Get all tables in a schema."""
        if self._conn is None:
            raise RuntimeError("Database connection not initialized. Call connect() first.")
        try:
            result = self._conn.execute(f"""
                SELECT table_name 
                FROM information_schema.tables
                WHERE table_schema = '{schema}' AND table_type = 'BASE TABLE'
            """).fetchall()
            return [row[0] for row in result]
        except Exception:
            # Fallback to SHOW TABLES
            try:
                result = self._conn.execute("SHOW TABLES").fetchall()
                return [row[0] for row in result]
            except Exception:
                return []
    
    async def _get_views(self, schema: str) -> List[str]:
        """Get all views in a schema."""
        if self._conn is None:
            raise RuntimeError("Database connection not initialized. Call connect() first.")
        try:
            result = self._conn.execute(f"""
                SELECT table_name 
                FROM information_schema.tables
                WHERE table_schema = '{schema}' AND table_type = 'VIEW'
            """).fetchall()
            return [row[0] for row in result]
        except Exception:
            return []
    
    async def _get_columns(self, schema: str, table: str) -> List[Column]:
        """Get columns for a table/view."""
        if self._conn is None:
            raise RuntimeError("Database connection not initialized. Call connect() first.")
        try:
            result = self._conn.execute(f"""
                SELECT 
                    column_name,
                    data_type,
                    ordinal_position,
                    is_nullable,
                    column_default
                FROM information_schema.columns
                WHERE table_schema = '{schema}' AND table_name = '{table}'
                ORDER BY ordinal_position
            """).fetchall()
            
            return [
                Column(
                    name=row[0],
                    type_name=row[1],
                    ordinal_position=row[2],
                    nullable=row[3] == 'YES',
                    primary_key=False,  # DuckDB PKs need separate query
                    autoincrement=False,
                )
                for row in result
            ]
        except Exception:
            # Fallback to DESCRIBE
            try:
                result = self._conn.execute(f"DESCRIBE {table}").fetchall()
                return [
                    Column(
                        name=row[0],
                        type_name=row[1],
                        ordinal_position=idx + 1,
                        nullable=True,
                        primary_key=False,
                    )
                    for idx, row in enumerate(result)
                ]
            except Exception:
                return []
    
    async def extract_schema(self) -> Dict[str, List[Table]]:
        """Extract complete schema from DuckDB database."""
        await self.connect()
        try:
            all_tables = []
            
            # Get tables in the default schema
            tables = await self._get_tables(self._schema)
            for table in tables:
                columns = await self._get_columns(self._schema, table)
                all_tables.append(Table(
                    name=table,
                    type='TABLE',
                    schema=self._schema,
                    columns=columns,
                ))
            
            # Get views
            views = await self._get_views(self._schema)
            for view in views:
                columns = await self._get_columns(self._schema, view)
                all_tables.append(Table(
                    name=view,
                    type='VIEW',
                    schema=self._schema,
                    columns=columns,
                ))
            
            return {"tables": [t.to_dict() for t in all_tables]}  # type: ignore[misc]
        finally:
            await self.disconnect()
    
    def generate_profiles_yml(self, project_name: str, target: str = "dev") -> str:
        """Generate dbt profiles.yml for DuckDB."""
        # ponytail: in-memory is never usable for dbt here (see DEFAULT_DB_FILE),
        # so an unset/':memory:' path becomes a project-local file.
        db_path = DEFAULT_DB_FILE if self._path == ":memory:" else self._path
        schema = self.config.get("schema", "main")
        threads = self.config.get("threads", 4)

        # Only include user-specified extensions, no implicit defaults
        extensions = self.config.get("extensions", [])
        extensions_yaml = ""
        if extensions:
            extensions_yaml = "\n      extensions:\n"
            for ext in extensions:
                extensions_yaml += f"        - {ext}\n"

        # Attached databases (a DuckLake catalog, for projects with ingest
        # sources) and engine settings (memory_limit, temp_directory, ...).
        # Rendered via yaml so nested dicts stay valid.
        attach_yaml = self._nested_block("attach", self.config.get("attach") or [])
        # Engine limits are passed in, not read from application config here:
        # adapters import nothing from `app`. See app/core/duckdb_resources.py.
        settings_yaml = self._nested_block("settings", self.config.get("settings") or {})

        database = self.config.get("database")
        database_yaml = f"\n      database: {database}" if database else ""

        return f"""{project_name}:
  outputs:
    {target}:
      type: duckdb
      path: '{db_path}'{database_yaml}
      schema: {schema}
      threads: {threads}{extensions_yaml.rstrip()}{settings_yaml}{attach_yaml}
  target: {target}
"""

    @staticmethod
    def _nested_block(key: str, value) -> str:
        """Render one nested profiles.yml key, indented under the target.

        Empty renders nothing: an empty `settings:` or `attach:` key is not the
        same as an absent one to dbt-duckdb.
        """
        if not value:
            return ""
        import yaml

        dumped = yaml.safe_dump(
            {key: value}, default_flow_style=False, sort_keys=False
        )
        return "\n" + "\n".join(
            f"      {line}" for line in dumped.rstrip().splitlines()
        )
