"""
Apache Spark adapter for dbt-spark profile generation and basic validation.
"""
from typing import Any, Dict, List

import yaml

from .base import BaseAdapter, Column, Table


class SparkAdapter(BaseAdapter):
    """Spark adapter.

    Supports dbt-spark methods: session, thrift, http, and odbc.
    """

    adapter_type = "spark"

    def _method(self) -> str:
        return str(self.config.get("method") or "session").lower()

    @staticmethod
    def _is_blank(value: Any) -> bool:
        return value is None or value == "" or value == 0 or value == "0"

    def _profile_output(self) -> Dict[str, Any]:
        method = self._method()
        output: Dict[str, Any] = {
            "type": "spark",
            "method": method,
        }

        scalar_fields = [
            "host",
            "user",
            "auth",
            "kerberos_service_name",
            "schema",
            "driver",
            "cluster",
            "endpoint",
            "organization",
            "connection_string_suffix",
        ]
        numeric_fields = [
            "threads",
            "connect_retries",
            "connect_timeout",
            "query_timeout",
            "poll_interval",
            "query_retries",
        ]
        boolean_fields = ["use_ssl", "retry_all"]

        for key in scalar_fields:
            value = self.config.get(key)
            if value not in (None, ""):
                output[key] = value

        port = self.config.get("port")
        if method != "session" and not self._is_blank(port):
            output["port"] = int(port)

        for key in numeric_fields:
            value = self.config.get(key)
            if value not in (None, ""):
                output[key] = int(value)

        for key in boolean_fields:
            value = self.config.get(key)
            if value not in (None, ""):
                output[key] = bool(value)

        secret_type = str(self.config.get("secret_type") or "none").lower()
        if secret_type in {"password", "token"}:
            secret_value = self.config.get(secret_type)
            if secret_value not in (None, ""):
                output[secret_type] = secret_value

        params = self.config.get("server_side_parameters")
        if isinstance(params, dict) and params:
            output["server_side_parameters"] = {
                str(key): "" if value is None else str(value)
                for key, value in params.items()
            }

        schema = output.get("schema")
        database = self.config.get("database")
        if database not in (None, "") and database == schema:
            output["database"] = database

        return output

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def test_connection(self) -> Dict[str, Any]:
        method = self._method()
        try:
            if method == "session":
                import pyspark  # noqa: F401

            profile = self._profile_output()
            return {
                "success": True,
                "message": f"Spark {method} profile is valid",
                "details": {
                    "method": method,
                    "host": profile.get("host"),
                    "schema": profile.get("schema"),
                },
            }
        except ImportError as exc:
            return {
                "success": False,
                "message": f"Missing Spark runtime dependency: {exc}",
            }
        except Exception as exc:
            return {"success": False, "message": str(exc)}

    async def extract_schema(self) -> Dict[str, List[Table]]:
        return {"tables": []}

    async def _get_schemas(self) -> List[str]:
        return []

    async def _get_tables(self, schema: str) -> List[str]:
        return []

    async def _get_views(self, schema: str) -> List[str]:
        return []

    async def _get_columns(self, schema: str, table: str) -> List[Column]:
        return []

    def generate_profiles_yml(self, project_name: str, target: str = "dev") -> str:
        profile = {
            project_name: {
                "outputs": {
                    target: self._profile_output(),
                },
                "target": target,
            }
        }
        return yaml.safe_dump(profile, sort_keys=False)
