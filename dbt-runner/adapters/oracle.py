"""
Oracle adapter - uses python-oracledb in async thin mode (no Instant Client).
Mirrors the PostgreSQL adapter structure.
"""
from typing import Any, Dict, List, Optional

from .base import BaseAdapter, Column, Table

# Oracle-maintained schemas we never want to surface to the user.
_SYSTEM_OWNERS = {
    "SYS", "SYSTEM", "OUTLN", "DBSNMP", "APPQOSSYS", "CTXSYS", "XDB", "WMSYS",
    "MDSYS", "ORDSYS", "ORDDATA", "OLAPSYS", "GSMADMIN_INTERNAL", "LBACSYS",
    "DVSYS", "AUDSYS", "DBSFWUSER", "REMOTE_SCHEDULER_AGENT", "SYS$UMF",
    "GGSYS", "ANONYMOUS", "XS$NULL", "OJVMSYS",
}


class OracleAdapter(BaseAdapter):
    """
    Oracle database adapter.

    Config structure:
    {
        "host": "localhost",
        "port": 1521,
        "user": "system",
        "password": "secret",
        "service": "ORCLPDB1",   # service name (dbt-oracle `service`)
        "schema": "ANALYTICS",   # optional, defaults to user (uppercased)
        "threads": 4             # optional, for profiles.yml
    }
    """

    adapter_type = "oracle"

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self._conn: Optional[Any] = None

    def _dsn(self) -> str:
        host = self.config.get("host")
        port = self.config.get("port", 1521)
        service = self.config.get("service")
        return f"{host}:{port}/{service}"

    def _owner(self) -> str:
        """Schema/owner to introspect. Defaults to the connecting user."""
        schema = self.config.get("schema") or self.config.get("user") or ""
        return schema.upper()

    async def connect(self) -> None:
        """Open an async thin-mode connection."""
        import oracledb
        self._conn = await oracledb.connect_async(
            user=self.config.get("user"),
            password=self.config.get("password"),
            dsn=self._dsn(),
        )

    async def disconnect(self) -> None:
        """Close the connection."""
        if self._conn:
            await self._conn.close()
            self._conn = None

    async def test_connection(self) -> Dict[str, Any]:
        """Test Oracle connection."""
        import oracledb
        try:
            conn = await oracledb.connect_async(
                user=self.config.get("user"),
                password=self.config.get("password"),
                dsn=self._dsn(),
            )
            with conn.cursor() as cursor:
                await cursor.execute(
                    "SELECT banner FROM v$version WHERE ROWNUM = 1"
                )
                row = await cursor.fetchone()
            await conn.close()

            version = row[0] if row else "Unknown"
            return {
                "success": True,
                "message": "Connected successfully to Oracle",
                "details": {
                    "version": version,
                    "host": self.config.get("host"),
                    "service": self.config.get("service"),
                },
            }
        except oracledb.DatabaseError as e:
            (error_obj,) = e.args
            code = getattr(error_obj, "code", None)
            message = getattr(error_obj, "message", str(e))
            if code == 1017:  # ORA-01017: invalid username/password
                return {"success": False, "message": "Invalid username or password"}
            if code == 12514:  # listener does not know of service
                return {
                    "success": False,
                    "message": f"Service '{self.config.get('service')}' not known by listener",
                }
            return {"success": False, "message": message}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def _get_schemas(self) -> List[str]:
        """Restrict introspection to the configured owner (avoids dumping SYS)."""
        owner = self._owner()
        return [owner] if owner else []

    async def _get_tables(self, schema: str) -> List[str]:
        if self._conn is None:
            raise RuntimeError("Connection not initialized. Call connect() first.")
        with self._conn.cursor() as cursor:
            await cursor.execute(
                "SELECT table_name FROM all_tables "
                "WHERE owner = :owner ORDER BY table_name",
                owner=schema,
            )
            rows = await cursor.fetchall()
        return [row[0] for row in rows]

    async def _get_views(self, schema: str) -> List[str]:
        if self._conn is None:
            raise RuntimeError("Connection not initialized. Call connect() first.")
        with self._conn.cursor() as cursor:
            await cursor.execute(
                "SELECT view_name FROM all_views "
                "WHERE owner = :owner ORDER BY view_name",
                owner=schema,
            )
            rows = await cursor.fetchall()
        return [row[0] for row in rows]

    async def _get_primary_keys(self, schema: str, table: str) -> set:
        """Return set of primary-key column names for a table."""
        with self._conn.cursor() as cursor:
            await cursor.execute(
                "SELECT acc.column_name "
                "FROM all_constraints ac "
                "JOIN all_cons_columns acc "
                "  ON ac.constraint_name = acc.constraint_name "
                "  AND ac.owner = acc.owner "
                "WHERE ac.constraint_type = 'P' "
                "  AND ac.owner = :owner AND ac.table_name = :tbl",
                owner=schema, tbl=table,
            )
            rows = await cursor.fetchall()
        return {row[0] for row in rows}

    async def _get_columns(self, schema: str, table: str) -> List[Column]:
        if self._conn is None:
            raise RuntimeError("Connection not initialized. Call connect() first.")
        pk_columns = await self._get_primary_keys(schema, table)
        with self._conn.cursor() as cursor:
            await cursor.execute(
                "SELECT column_name, data_type, column_id, nullable, "
                "data_length, data_precision, data_scale, identity_column "
                "FROM all_tab_columns "
                "WHERE owner = :owner AND table_name = :tbl "
                "ORDER BY column_id",
                owner=schema, tbl=table,
            )
            rows = await cursor.fetchall()

        return [
            Column(
                name=row[0],
                type_name=row[1],
                ordinal_position=row[2] or 0,
                nullable=row[3] == "Y",
                primary_key=row[0] in pk_columns,
                autoincrement=row[7] == "YES",
                column_display_size=row[4] or row[5] or 0,
                scale=row[6] or 0,
                precision=row[5] or 0,
            )
            for row in rows
        ]

    async def extract_schema(self) -> Dict[str, List[Table]]:
        """Extract tables and views for the configured owner."""
        await self.connect()
        try:
            schemas = await self._get_schemas()
            all_tables: List[Table] = []

            for schema in schemas:
                for table in await self._get_tables(schema):
                    all_tables.append(Table(
                        name=table,
                        type="TABLE",
                        schema=schema,
                        columns=await self._get_columns(schema, table),
                    ))
                for view in await self._get_views(schema):
                    all_tables.append(Table(
                        name=view,
                        type="VIEW",
                        schema=schema,
                        columns=await self._get_columns(schema, view),
                    ))

            return {"tables": [t.to_dict() for t in all_tables]}  # type: ignore[misc]
        finally:
            await self.disconnect()

    def generate_profiles_yml(self, project_name: str, target: str = "dev") -> str:
        """Generate dbt profiles.yml for Oracle (dbt-oracle adapter)."""
        return f"""{project_name}:
  outputs:
    {target}:
      type: oracle
      protocol: tcp
      host: {self.config.get("host")}
      port: {self.config.get("port", 1521)}
      service: {self.config.get("service")}
      user: {self.config.get("user")}
      password: "{self.config.get("password")}"
      schema: {self._owner()}
      threads: {self.config.get("threads", 4)}
  target: {target}
"""
