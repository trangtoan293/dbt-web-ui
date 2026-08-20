"""
Health check router.
"""

from fastapi import APIRouter, Response

from app.core.metrics import PROMETHEUS_CONTENT_TYPE, metrics_registry

router = APIRouter(tags=["Health"])


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "dbt-runner"}


@router.get("/metrics")
async def prometheus_metrics():
    """Prometheus text metrics endpoint."""
    return Response(
        content=metrics_registry.render(),
        media_type=PROMETHEUS_CONTENT_TYPE,
    )
