"""Exercise the pinned dbt-charts engine, not a substitute chart renderer."""

import asyncio
import sys
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.charts import ChartRequest, build_board, render_chart


def request(**overrides):
    values = dict(columns=["region.name", "revenue"], data=[
        {"region.name": "North", "revenue": 12}, {"region.name": "South", "revenue": 18},
    ], x="region.name", y="revenue")
    return ChartRequest(**(values | overrides))


@pytest.mark.parametrize("kind", ["bar", "line", "area", "scatter", "pie", "donut", "table", "kpi"])
def test_real_renderer(kind):
    overrides = {"chart_type": kind}
    if kind == "kpi":
        overrides["data"] = [{"region.name": "Total", "revenue": 30}]
    result = asyncio.run(render_chart(request(**overrides)))
    assert "<svg" in result["html"]
    assert "dbt-charts 0.8.0" == result["renderer"]
    assert "queries:" in result["yaml"]
    assert "<script src=" not in result["html"]


def test_board_contains_only_inline_data_and_escapes_field_names():
    board = yaml.safe_load(build_board(request()))
    assert set(board) == {"theme", "queries", "charts", "rows"}
    assert board["queries"]["result"] == {"columns": ["field_0", "field_1"], "values": [["North", 12], ["South", 18]]}
    assert board["charts"]["result"]["x"] == "field_0"
    assert board["charts"]["result"]["x_label"] == "region.name"


@pytest.mark.parametrize("theme", ["clarity", "paper", "vivid", "neon", "stark"])
def test_real_renderer_themes(theme):
    result = asyncio.run(render_chart(request(theme=theme)))
    assert "<svg" in result["html"]
    assert yaml.safe_load(result["yaml"])["theme"] == theme


@pytest.mark.parametrize("overrides", [
    {"x": "missing"}, {"y": "region.name"}, {"chart_type": "kpi"},
    {"chart_type": "pie", "data": [{"revenue": -1}]},
    {"data": [{"revenue": float("inf")}]}, {"data": [{"revenue": True}]},
    {"title": "{{ env_var('SECRET') }}"},
    {"data": [{"region.name": "{% include '/etc/passwd' %}", "revenue": 1}]},
    {"data": []}, {"data": [{"revenue": 1}] * 1001},
    {"columns": ["x", "x"]}, {"source": "/etc/passwd"},
])
def test_rejects_invalid_or_executable_input(overrides):
    with pytest.raises(ValidationError):
        request(**overrides)


def test_null_is_preserved_not_converted_to_zero():
    board = yaml.safe_load(build_board(request(data=[{"revenue": 12}, {"revenue": None}])))
    assert board["queries"]["result"]["values"] == [[None, 12], [None, None]]


def test_html_text_is_escaped_by_real_renderer():
    result = asyncio.run(render_chart(request(title='<img src=x onerror="alert(1)">')))
    assert '<img src=x onerror="alert(1)">' not in result["html"]


def test_authenticated_route_rejects_large_and_invalid_bodies(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.auth import require_user
    from app.routers.charts import router
    from app.services.charts import MAX_BYTES

    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[require_user] = lambda: {"sub": "test-user"}
    client = TestClient(application)
    assert client.post("/charts/render", content=b"x" * (MAX_BYTES + 1)).status_code == 413
    invalid = client.post("/charts/render", json={"columns": [], "data": []})
    assert invalid.status_code == 422


def test_route_requires_authentication(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.config import settings
    from app.routers.charts import router

    monkeypatch.setattr(settings, "auth_disabled", False)
    application = FastAPI()
    application.include_router(router)
    response = TestClient(application).post("/charts/render", json=request().model_dump())
    assert response.status_code == 401


def test_route_renders_real_chart_without_cache():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.auth import require_user
    from app.routers.charts import router

    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[require_user] = lambda: {"sub": "test-user"}
    response = TestClient(application).post("/charts/render", json=request().model_dump())
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "<svg" in response.json()["html"]


def test_snapshot_warnings_are_objects_the_browser_can_label():
    # The viewer prints message and fix; a bare string would lose the engine's advice.
    result = asyncio.run(render_chart(request(y="revenue", title="Revenue")))
    assert isinstance(result["warnings"], list)
    assert all({"message", "level", "code", "fix"} <= set(item) for item in result["warnings"])
