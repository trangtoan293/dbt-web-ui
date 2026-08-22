"""
Routers exports.
"""

from app.routers.client_logs import router as client_logs_router
from app.routers.connection import router as connection_router
from app.routers.dbt import router as dbt_router
from app.routers.dremio import router as dremio_router
from app.routers.files import router as files_router
from app.routers.git import router as git_router
from app.routers.health import router as health_router
from app.routers.ingest import router as ingest_router
from app.routers.process import router as process_router
from app.routers.project import router as project_router
from app.routers.sse import router as sse_router
from app.routers.system import router as system_router

__all__ = [
    "health_router",
    "dbt_router",
    "git_router",
    "files_router",
    "client_logs_router",
    "connection_router",
    "ingest_router",
    "process_router",
    "sse_router",
    "project_router",
    "dremio_router",
    "system_router",
]
