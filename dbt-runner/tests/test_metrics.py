from fastapi import FastAPI
from fastapi import Response
from fastapi.testclient import TestClient

from app.core.metrics import (
    PROMETHEUS_CONTENT_TYPE,
    PrometheusMetricsMiddleware,
    metrics_registry,
)


def _test_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(PrometheusMetricsMiddleware)

    @app.get("/health")
    async def health_check():
        return {"status": "healthy", "service": "dbt-runner"}

    @app.get("/metrics")
    async def prometheus_metrics():
        return Response(
            content=metrics_registry.render(),
            media_type=PROMETHEUS_CONTENT_TYPE,
        )

    return app


def test_metrics_endpoint_returns_prometheus_text():
    client = TestClient(_test_app())

    response = client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "# TYPE dbt_runner_http_requests_total counter" in response.text
    assert "dbt_runner_process_start_time_seconds" in response.text


def test_metrics_record_request_without_counting_scrape():
    client = TestClient(_test_app())

    client.get("/health")
    response = client.get("/metrics")

    assert (
        'dbt_runner_http_requests_total{method="GET",path="/health",status="200"} 1'
        in response.text
    )
    assert 'path="/metrics"' not in response.text
