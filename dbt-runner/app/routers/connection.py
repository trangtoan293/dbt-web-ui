"""
Connection and profiles router.
"""

import logging

import yaml
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from adapters import get_adapter, list_adapters
from app.core.db import get_session
from app.core.dependencies import get_project_service
from app.models.connection import (
    ConnectionSchemaRequest,
    ConnectionTestRequest,
    DremioTestRequest,
    ProfilesGenerateV2Request,
    ProfilesYamlRequest,
)
from app.services.project import ProjectService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Connections"])


@router.get("/connection/usage/{connection_id}")
async def get_connection_usage(
    connection_id: str,
    session: AsyncSession = Depends(get_session),
):
    """
    Check which projects are using this connection.
    Returns list of projects that have this connection assigned.
    """
    try:
        logger.info(
            f"[CONNECTION USAGE CHECK] Checking usage for connection_id: {connection_id}"
        )

        # Parameterized query; cast to uuid since dremio_source_id is a UUID column.
        result = await session.execute(
            text(
                "SELECT id, name, description, dremio_source_id "
                "FROM dbt_projects "
                "WHERE dremio_source_id = CAST(:cid AS uuid) "
                "AND deleted_at IS NULL"
            ),
            {"cid": connection_id},
        )
        projects = [dict(row) for row in result.mappings().all()]

        logger.info(
            f"[CONNECTION USAGE CHECK] Found {len(projects)} projects using connection {connection_id}"
        )

        return {
            "in_use": len(projects) > 0,
            "project_count": len(projects),
            "projects": projects,
        }
    except Exception as e:
        logger.error(f"Error checking connection usage: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/connection/adapters")
async def list_available_adapters():
    """List all available connection adapter types."""
    return {"adapters": list_adapters(), "supported": list(list_adapters().keys())}


@router.post("/connection/test")
async def test_connection(request: ConnectionTestRequest):
    """
    Test any connection type using the adapter pattern.
    Supports: postgresql, duckdb, dremio (and more as added)
    """
    logger.debug(f"[CONNECTION TEST] type={request.type}, name={request.name}")

    try:
        adapter = get_adapter(request.type, request.config)
        result = await adapter.test_connection()
        return result
    except ValueError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        return {"success": False, "message": f"Unexpected error: {str(e)}"}


@router.post("/connection/schema")
async def extract_connection_schema(request: ConnectionSchemaRequest):
    """
    Extract schema (tables, views, columns) from any connection type.
    Returns the complete schema metadata for the database.
    """
    try:
        adapter = get_adapter(request.type, request.config)
        schema = await adapter.extract_schema()
        return {"success": True, "schema": schema}
    except ValueError as e:
        return {"success": False, "message": str(e), "schema": None}
    except Exception as e:
        return {
            "success": False,
            "message": f"Schema extraction failed: {str(e)}",
            "schema": None,
        }


@router.post("/profiles/generate-v2")
async def generate_profiles_v2(
    request: ProfilesGenerateV2Request,
    project_service: ProjectService = Depends(get_project_service),
):
    """
    Generate profiles.yml for any connection type using the adapter pattern.
    Automatically reads profile name from dbt_project.yml.
    If no connection is configured, generates a template for manual customization.
    """
    project_path = project_service.get_path_or_raise(request.project_id)

    dbt_project_file = project_path / "dbt_project.yml"
    if not dbt_project_file.exists():
        raise HTTPException(status_code=404, detail="dbt_project.yml not found")

    try:
        with open(dbt_project_file, "r") as f:
            dbt_project = yaml.safe_load(f)

        # Get profile name from dbt_project.yml
        profile_name = dbt_project.get("profile")
        if not profile_name:
            profile_name = dbt_project.get("name", request.project_name)

        # Check if connection config is empty/null - generate template
        if not request.connection_config or request.connection_config == {}:
            profiles_content = f"""# dbt Profile Configuration
# 
# This is a template profiles.yml file. Please customize it with your actual
# database connection details.
#
# For more information on configuring profiles, see:
# https://docs.getdbt.com/docs/core/connect-data-platform/profiles.yml

{profile_name}:
  outputs:
    dev:
      # Choose your adapter type: postgres, duckdb, dremio, snowflake, etc.
      type: postgres  # Change this to your database type
      
      # PostgreSQL example:
      threads: 4
      host: localhost
      port: 5432
      user: your_username
      password: your_password
      dbname: your_database
      schema: public
      
      # DuckDB example (uncomment and modify if using DuckDB):
      # type: duckdb
      # path: /path/to/your/database.duckdb
      # threads: 4
      
      # Dremio example (uncomment and modify if using Dremio):
      # type: dremio
      # software_host: your.dremio.host
      # port: 9047
      # use_ssl: false
      # pat: "your_personal_access_token"
      # dremio_space: "@dremio"
      
  target: dev
"""
            profiles_path = project_path / "profiles.yml"
            profiles_path.write_text(profiles_content.strip())

            return {
                "success": True,
                "message": "Template profiles.yml generated - please customize with your connection details",
                "path": str(profiles_path),
                "profile_name": profile_name,
                "content": profiles_content.strip(),
                "is_template": True,
            }

        # Generate profiles using the adapter
        adapter = get_adapter(request.connection_type, request.connection_config)
        profiles_content = adapter.generate_profiles_yml(profile_name)

        profiles_path = project_path / "profiles.yml"
        profiles_path.write_text(profiles_content.strip())

        return {
            "success": True,
            "message": f"profiles.yml generated for {request.connection_type}",
            "path": str(profiles_path),
            "profile_name": profile_name,
            "content": profiles_content.strip(),
            "is_template": False,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================
# Legacy Dremio-specific Endpoints
# ============================================


@router.post("/dremio/test")
async def test_dremio_connection(request: DremioTestRequest):
    """Test connection to Dremio using REST API (legacy endpoint)."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            headers = {"Authorization": f"Bearer {request.token}"}
            url = f"http://{request.host}:{request.port}/api/v3/user"
            response = await client.get(url, headers=headers)

            if response.status_code == 200:
                user_info = response.json()
                return {
                    "success": True,
                    "message": f"Connected successfully as {user_info.get('userName', 'unknown')}",
                    "host": request.host,
                    "port": request.port,
                }
            elif response.status_code == 401:
                return {
                    "success": False,
                    "message": "Authentication failed - invalid token",
                }
            else:
                return {
                    "success": False,
                    "message": f"Connection failed with status {response.status_code}",
                }
    except httpx.ConnectError:
        return {
            "success": False,
            "message": f"Cannot connect to {request.host}:{request.port}",
        }
    except Exception as e:
        return {"success": False, "message": f"Connection error: {str(e)}"}


@router.post("/profiles/generate")
async def generate_profiles_yaml(
    request: ProfilesYamlRequest,
    project_service: ProjectService = Depends(get_project_service),
):
    """Generate profiles.yml for a dbt project with Dremio connection (legacy)."""
    project_path = project_service.get_path_or_raise(request.project_id)

    profiles_content = f"""
{request.project_name}:
  outputs:
    dev:
      type: dremio
      threads: 4
      software_host: {request.dremio_host}
      port: {request.dremio_port}
      use_ssl: false
      pat: "{request.dremio_token}"
      cloud_project_id: ""
      cloud_host: ""
      
      # Arrow Flight connection for queries
      dremio_space: "@dremio"
      dremio_space_folder: ""
      object_storage_source: ""
      object_storage_path: ""

  target: dev
"""

    profiles_path = project_path / "profiles.yml"
    try:
        profiles_path.write_text(profiles_content.strip())
        return {
            "success": True,
            "message": "profiles.yml generated successfully",
            "path": str(profiles_path),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
