"""
PostgreSQL adapter - mirrors pg.extractor.ts
Uses asyncpg for async PostgreSQL connections.
"""
from typing import Any, Dict, List, Optional

from .base import BaseAdapter, Column, Table


class PostgreSQLAdapter(BaseAdapter):
    """
    PostgreSQL database adapter.
    
    Config structure:
    {
        "host": "localhost",
        "port": 5432,
        "user": "postgres",
        "password": "secret",
        "dbname": "mydb",
        "schema": "public",  # optional, for profiles.yml
        "threads": 4         # optional, for profiles.yml
    }
    """
    
    adapter_type = "postgresql"

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self._pool: Optional[Any] = None
    
    async def connect(self) -> None:
        """Create async connection pool."""
        import asyncpg
        self._pool = await asyncpg.create_pool(
            host=self.config.get("host"),
            port=self.config.get("port", 5432),
            user=self.config.get("user"),
            password=self.config.get("password"),
            database=self.config.get("dbname"),
            min_size=1,
            max_size=5,
        )
    
    async def disconnect(self) -> None:
        """Close connection pool."""
        if self._pool:
            await self._pool.close()
            self._pool = None
    
    async def test_connection(self) -> Dict[str, Any]:
        """Test PostgreSQL connection."""
        import asyncpg
        try:
            conn = await asyncpg.connect(
                host=self.config.get("host"),
                port=self.config.get("port", 5432),
                user=self.config.get("user"),
                password=self.config.get("password"),
                database=self.config.get("dbname"),
                timeout=10,
            )
            version = await conn.fetchval("SELECT version()")
            await conn.close()
            
            # Extract short version info
            short_version = version.split(",")[0] if version else "Unknown"
            
            return {
                "success": True,
                "message": f"Connected successfully to PostgreSQL",
                "details": {
                    "version": short_version,
                    "host": self.config.get("host"),
                    "database": self.config.get("dbname"),
                }
            }
        except asyncpg.InvalidPasswordError:
            return {"success": False, "message": "Invalid password"}
        except asyncpg.InvalidCatalogNameError:
            return {"success": False, "message": f"Database '{self.config.get('dbname')}' does not exist"}
        except OSError as e:
            return {"success": False, "message": f"Cannot connect to {self.config.get('host')}:{self.config.get('port')} - {str(e)}"}
        except Exception as e:
            return {"success": False, "message": str(e)}
    
    async def _get_schemas(self) -> List[str]:
        """Get all user schemas (excluding system schemas)."""
        if self._pool is None:
            raise RuntimeError("Database pool not initialized. Call connect() first.")
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT schema_name 
                FROM information_schema.schemata
                WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
                ORDER BY schema_name
            """)
            return [row['schema_name'] for row in rows]
    
    async def _get_tables(self, schema: str) -> List[str]:
        """Get all tables in a schema."""
        if self._pool is None:
            raise RuntimeError("Database pool not initialized. Call connect() first.")
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT table_name 
                FROM information_schema.tables
                WHERE table_schema = $1 AND table_type = 'BASE TABLE'
                ORDER BY table_name
            """, schema)
            return [row['table_name'] for row in rows]
    
    async def _get_views(self, schema: str) -> List[str]:
        """Get all views in a schema."""
        if self._pool is None:
            raise RuntimeError("Database pool not initialized. Call connect() first.")
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT table_name
                FROM information_schema.views
                WHERE table_schema = $1
                ORDER BY table_name
            """, schema)
            return [row['table_name'] for row in rows]
    
    async def _get_columns(self, schema: str, table: str) -> List[Column]:
        """Get detailed column info for a table/view."""
        if self._pool is None:
            raise RuntimeError("Database pool not initialized. Call connect() first.")
        async with self._pool.acquire() as conn:
            rows = await conn.fetch("""
                SELECT 
                    c.column_name,
                    c.data_type,
                    c.ordinal_position,
                    c.is_nullable,
                    c.character_maximum_length,
                    c.numeric_precision,
                    c.numeric_scale,
                    c.column_default,
                    EXISTS (
                        SELECT 1 
                        FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu
                            ON tc.constraint_name = kcu.constraint_name
                            AND tc.table_schema = kcu.table_schema
                        WHERE tc.constraint_type = 'PRIMARY KEY'
                            AND tc.table_schema = c.table_schema
                            AND tc.table_name = c.table_name
                            AND kcu.column_name = c.column_name
                    ) AS is_primary
                FROM information_schema.columns c
                WHERE c.table_schema = $1 AND c.table_name = $2
                ORDER BY c.ordinal_position
            """, schema, table)
            
            return [
                Column(
                    name=row['column_name'],
                    type_name=row['data_type'],
                    ordinal_position=row['ordinal_position'],
                    nullable=row['is_nullable'] == 'YES',
                    primary_key=row['is_primary'],
                    autoincrement='nextval' in (row['column_default'] or ''),
                    column_display_size=row['character_maximum_length'] or row['numeric_precision'] or 0,
                    scale=row['numeric_scale'] or 0,
                    precision=row['numeric_precision'] or 0,
                )
                for row in rows
            ]
    
    async def extract_schema(self) -> Dict[str, List[Table]]:
        """Extract complete schema from PostgreSQL database."""
        await self.connect()
        try:
            schemas = await self._get_schemas()
            all_tables = []
            
            for schema in schemas:
                # Get tables
                tables = await self._get_tables(schema)
                for table in tables:
                    columns = await self._get_columns(schema, table)
                    all_tables.append(Table(
                        name=table,
                        type='TABLE',
                        schema=schema,
                        columns=columns,
                    ))
                
                # Get views
                views = await self._get_views(schema)
                for view in views:
                    columns = await self._get_columns(schema, view)
                    all_tables.append(Table(
                        name=view,
                        type='VIEW',
                        schema=schema,
                        columns=columns,
                    ))
            
            return {"tables": [t.to_dict() for t in all_tables]}  # type: ignore[misc]
        finally:
            await self.disconnect()
    
    def generate_profiles_yml(self, project_name: str, target: str = "dev") -> str:
        """Generate dbt profiles.yml for PostgreSQL."""
        return f"""{project_name}:
  outputs:
    {target}:
      type: postgres
      host: {self.config.get("host")}
      port: {self.config.get("port", 5432)}
      user: {self.config.get("user")}
      password: "{self.config.get("password")}"
      dbname: {self.config.get("dbname")}
      schema: {self.config.get("schema", "public")}
      threads: {self.config.get("threads", 4)}
  target: {target}
"""
