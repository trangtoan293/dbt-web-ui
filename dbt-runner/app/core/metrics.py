"""
Small Prometheus text metrics collector.

This intentionally avoids prometheus-client so the service can expose a useful
/metrics endpoint without adding a dependency.
"""

from __future__ import annotations

import math
import time
from collections import Counter
from threading import Lock

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware


PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


class MetricsRegistry:
    """In-memory counters for a single dbt-runner process."""

    def __init__(self) -> None:
        self.process_start_time_seconds = time.time()
        self._lock = Lock()
        self._requests_total: Counter[tuple[str, str, str]] = Counter()
        self._duration_seconds_sum: Counter[tuple[str, str, str]] = Counter()
        self._duration_seconds_count: Counter[tuple[str, str, str]] = Counter()
        self._requests_in_progress = 0

    def inc_in_progress(self) -> None:
        with self._lock:
            self._requests_in_progress += 1

    def dec_in_progress(self) -> None:
        with self._lock:
            self._requests_in_progress = max(0, self._requests_in_progress - 1)

    def observe_request(
        self,
        *,
        method: str,
        path: str,
        status: int,
        duration_seconds: float,
    ) -> None:
        labels = (method, path, str(status))
        with self._lock:
            self._requests_total[labels] += 1
            self._duration_seconds_count[labels] += 1
            self._duration_seconds_sum[labels] += duration_seconds

    def render(self) -> str:
        with self._lock:
            requests_total = self._requests_total.copy()
            duration_count = self._duration_seconds_count.copy()
            duration_sum = self._duration_seconds_sum.copy()
            requests_in_progress = self._requests_in_progress

        lines = [
            "# HELP dbt_runner_process_start_time_seconds Unix time when the process started.",
            "# TYPE dbt_runner_process_start_time_seconds gauge",
            f"dbt_runner_process_start_time_seconds {self.process_start_time_seconds:.6f}",
            "# HELP dbt_runner_http_requests_in_progress Current HTTP requests in progress.",
            "# TYPE dbt_runner_http_requests_in_progress gauge",
            f"dbt_runner_http_requests_in_progress {requests_in_progress}",
            "# HELP dbt_runner_http_requests_total Total HTTP requests.",
            "# TYPE dbt_runner_http_requests_total counter",
        ]

        for labels, value in sorted(requests_total.items()):
            lines.append(
                "dbt_runner_http_requests_total"
                f"{_format_labels(labels)} {_format_number(value)}"
            )

        lines.extend(
            [
                "# HELP dbt_runner_http_request_duration_seconds HTTP request duration in seconds.",
                "# TYPE dbt_runner_http_request_duration_seconds summary",
            ]
        )

        for labels, value in sorted(duration_count.items()):
            lines.append(
                "dbt_runner_http_request_duration_seconds_count"
                f"{_format_labels(labels)} {_format_number(value)}"
            )
        for labels, value in sorted(duration_sum.items()):
            lines.append(
                "dbt_runner_http_request_duration_seconds_sum"
                f"{_format_labels(labels)} {_format_number(value)}"
            )

        return "\n".join(lines) + "\n"


metrics_registry = MetricsRegistry()


class PrometheusMetricsMiddleware(BaseHTTPMiddleware):
    """Record basic request counters and durations for Prometheus scraping."""

    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/metrics":
            return await call_next(request)

        method = request.method
        start = time.perf_counter()
        metrics_registry.inc_in_progress()
        try:
            response = await call_next(request)
        except Exception:
            duration_seconds = time.perf_counter() - start
            metrics_registry.observe_request(
                method=method,
                path=_route_path(request),
                status=500,
                duration_seconds=duration_seconds,
            )
            raise
        finally:
            metrics_registry.dec_in_progress()

        duration_seconds = time.perf_counter() - start
        metrics_registry.observe_request(
            method=method,
            path=_route_path(request),
            status=response.status_code,
            duration_seconds=duration_seconds,
        )
        return response


def _route_path(request: Request) -> str:
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if path:
        return path
    return request.url.path


def _format_labels(values: tuple[str, str, str]) -> str:
    method, path, status = values
    return (
        '{method="'
        + _escape_label_value(method)
        + '",path="'
        + _escape_label_value(path)
        + '",status="'
        + _escape_label_value(status)
        + '"}'
    )


def _escape_label_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _format_number(value: int | float) -> str:
    if isinstance(value, int):
        return str(value)
    if math.isfinite(value):
        return f"{value:.6f}"
    return str(value)
