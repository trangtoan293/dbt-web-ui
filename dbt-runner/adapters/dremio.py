"""
Dremio adapter - REST API + Arrow Flight.
For both Dremio Cloud and Dremio Software.
"""
from typing import Dict, Any, List
from .base import BaseAdapter, Column, Table


class DremioAdapter(BaseAdapter):
    """
    Dremio database adapter.
    
    Config structure for Dremio Cloud:
    {
        "is_cloud": true,
        "cloud_host": "api.dremio.cloud",
        "cloud_project_id": "project-id",
        "pat": "personal-access-token",
        "dremio_space": "@dremio",
        "dremio_space_folder": "",
        "object_storage_source": "",
        "object_storage_path": "",
        "threads": 4
    }
    
    Config structure for Dremio Software:
    {
        "is_cloud": false,
        "host": "dremio.example.com",
        "port": 9047,
        "pat": "personal-access-token",
        "dremio_space": "@dremio",
        "dremio_space_folder": "",
        "object_storage_source": "",
        "object_storage_path": "",
        "threads": 4
    }
    """
    
    adapter_type = "dremio"
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self._is_cloud = config.get("is_cloud", False)
        self._host = config.get("host") or config.get("software_host")
        self._port = config.get("port", 9047)
        self._pat = config.get("pat")
        self._password = config.get("password")
        self._user = config.get("user") or config.get("username")
        self._cloud_host = config.get("cloud_host", "api.dremio.cloud")
        self._test_timeout = float(config.get("test_timeout", 15.0))
    
    def _get_base_url(self) -> str:
        """Get the base URL for Dremio API."""
        if self._is_cloud:
            return f"https://{self._cloud_host}"
        else:
            return f"http://{self._host}:{self._port}"
    
    def _get_headers(self) -> Dict[str, str]:
        """Get authorization headers."""
        return {"Authorization": f"Bearer {self._pat}"}

    async def _get_password_headers(self, client: Any) -> Dict[str, str]:
        """Exchange Dremio software username/password for a short-lived auth token."""
        response = await client.post(
            f"{self._get_base_url()}/apiv2/login",
            json={"userName": self._user, "password": self._password},
        )
        if response.status_code == 401:
            return {}
        response.raise_for_status()
        token = response.json().get("token")
        return {"Authorization": f"_dremio{token}"} if token else {}
    
    async def connect(self) -> None:
        """Dremio uses REST API, no persistent connection needed."""
        pass
    
    async def disconnect(self) -> None:
        """No cleanup needed for REST API."""
        pass
    
    async def test_connection(self) -> Dict[str, Any]:
        """Test Dremio by submitting the smallest query dbt could run.

        Not a catalog read: ``GET /api/v3/user`` and ``GET /api/v3/catalog``
        never answer on a coordinator whose sources are slow to enumerate - they
        hold the connection open until the client gives up, so a working server
        reported "Connection timed out". Neither proves dbt can run anything
        either. ``POST /api/v3/sql`` is the endpoint dbt itself depends on, it
        answers 401 on bad credentials, and it returns as soon as the job is
        queued.
        """
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self._test_timeout) as client:
                headers = self._get_headers()
                if self._password and self._user:
                    headers = await self._get_password_headers(client)
                    if not headers:
                        return {"success": False, "message": "Invalid username or password"}
                response = await client.post(
                    f"{self._get_base_url()}/api/v3/sql",
                    headers=headers,
                    json={"sql": "SELECT 1"},
                )

                if response.status_code == 200:
                    return {
                        "success": True,
                        "message": f"Connected as {self._user or 'unknown'}",
                        "details": {
                            "user": self._user,
                            "type": "cloud" if self._is_cloud else "software",
                            "job_id": response.json().get("id"),
                        },
                    }
                if response.status_code == 401:
                    credential = "username/password" if self._password else "PAT token"
                    return {"success": False, "message": f"Invalid {credential} - authentication failed"}
                if response.status_code == 403:
                    return {"success": False, "message": "Access forbidden - check the account's permissions"}
                return {
                    "success": False,
                    "message": f"Connection failed with status {response.status_code}",
                }
        except httpx.ConnectError:
            return {
                "success": False,
                "message": f"Cannot connect to {self._get_base_url()}",
            }
        except httpx.TimeoutException:
            return {"success": False, "message": "Connection timed out"}
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def _get_schemas(self) -> List[str]:
        """Get schemas/spaces from Dremio catalog."""
        # TODO: Implement via Dremio REST API /api/v3/catalog
        return []
    
    async def _get_tables(self, schema: str) -> List[str]:
        """Get tables in a Dremio space."""
        # TODO: Implement via Dremio REST API
        return []
    
    async def _get_views(self, schema: str) -> List[str]:
        """Get views in a Dremio space."""
        # TODO: Implement via Dremio REST API
        return []
    
    async def _get_columns(self, schema: str, table: str) -> List[Column]:
        """Get columns via Arrow Flight or REST API."""
        # TODO: Implement via Arrow Flight for performance
        return []
    
    async def extract_schema(self) -> Dict[str, List[Table]]:
        """
        Extract schema from Dremio.
        Note: Full implementation requires Arrow Flight for efficiency.
        """
        # TODO: Implement full schema extraction
        # This would use the Dremio REST API to navigate the catalog
        # and Arrow Flight to execute DESCRIBE queries
        return {"tables": []}
    
    def generate_profiles_yml(self, project_name: str, target: str = "dev") -> str:
        """Generate dbt profiles.yml for Dremio.

        dbt-dremio requires the ``user`` field in both cloud and software modes,
        even when authenticating via PAT.  Without it dbt raises a validation error.
        """
        user = self.config.get("user") or self.config.get("username") or ""
        # Parenthesised on purpose: `a or b if user else c` binds as
        # `(a or b) if user else c`, which threw away an explicit dremio_space
        # whenever user was empty and wrote models to @dremio instead.
        dremio_space = self.config.get("dremio_space") or (f"@{user}" if user else "@dremio")
        dremio_space_folder = self.config.get("dremio_space_folder", "")
        object_storage_source = self.config.get("object_storage_source", "")
        object_storage_path = self.config.get("object_storage_path", "")
        threads = self.config.get("threads", 4)

        if self._is_cloud:
            return f"""{project_name}:
  outputs:
    {target}:
      type: dremio
      cloud_host: {self._cloud_host}
      cloud_project_id: "{self.config.get("cloud_project_id", "")}"
      user: "{user}"
      pat: "{self._pat}"
      dremio_space: "{dremio_space}"
      dremio_space_folder: "{dremio_space_folder}"
      object_storage_source: "{object_storage_source}"
      object_storage_path: "{object_storage_path}"
      threads: {threads}
      use_ssl: true
  target: {target}
"""
        else:
            use_ssl = self.config.get("use_ssl", False)
            twin_strategy = self.config.get("twin_strategy", "")
            # Support both password auth and PAT auth for software mode
            password = self.config.get("password")
            if password:
                auth_line = f'      password: "{password}"'
            else:
                auth_line = f'      pat: "{self._pat}"'
            twin_line = f"\n      twin_strategy: {twin_strategy}" if twin_strategy else ""
            return f"""{project_name}:
  outputs:
    {target}:
      type: dremio
      software_host: {self._host}
      port: {self._port}
      user: "{user}"
{auth_line}
      use_ssl: {str(use_ssl).lower()}
      dremio_space: "{dremio_space}"
      dremio_space_folder: "{dremio_space_folder}"
      object_storage_source: "{object_storage_source}"
      object_storage_path: "{object_storage_path}"
      threads: {threads}{twin_line}
  target: {target}
"""
