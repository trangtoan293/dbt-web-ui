"""Render bounded, inline query snapshots through the real dbt-charts CLI.

Only this module creates board YAML. No client SQL, paths, templates or arbitrary
board definitions reach dct, and the child receives no warehouse credentials.
"""

import asyncio
import json
import math
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

ChartType = Literal["bar", "line", "area", "scatter", "pie", "donut", "kpi", "table"]
NumberFormat = Literal["integer", "number", "number_full", "currency", "currency_whole",
                       "currency_full", "percent", "percent_whole", "percent_delta"]
# pie, donut and table have no number_format slot; a table formats per column.
FORMATTED_TYPES = ("bar", "line", "area", "scatter", "histogram", "heatmap")
CHART_VERSION = "0.8.0"
MAX_BYTES = 2_000_000
RENDER_TIMEOUT = 45
_render_slots = asyncio.Semaphore(2)


def diagnostic(item: dict) -> dict:
    """Keep the engine's own fix text and location; a bare message hides why a chart is empty."""
    text = lambda key, limit: str(item.get(key) or "")[:limit] or None  # noqa: E731
    return {
        "message": text("message", 500) or "Chart rendering diagnostic",
        "level": text("level", 20) or "warning",
        "code": text("code", 80),
        "fix": text("fix", 500),
        "chart": text("chart", 120),
        "path": text("path", 200),
    }


class ChartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[str] = Field(min_length=1, max_length=80)
    data: list[dict[str, str | int | float | bool | None]] = Field(min_length=1, max_length=1000)
    chart_type: ChartType = "bar"
    title: str = Field(default="Query results", max_length=160)
    x: str | None = None
    y: str | None = None
    color: str | None = None
    theme: Literal["clarity", "paper", "vivid", "neon", "stark"] = "clarity"
    number_format: NumberFormat | None = None

    @model_validator(mode="after")
    def validate_chart(self):
        if len(set(self.columns)) != len(self.columns):
            raise ValueError("Column names must be unique")
        if any(not col or len(col) > 200 for col in self.columns):
            raise ValueError("Column names must contain 1–200 characters")
        if len(self.model_dump_json().encode()) > MAX_BYTES:
            raise ValueError("Chart data exceeds the 2 MB limit")
        # dct interpolates authored strings. User text is data, never a template.
        for value in [self.title, *self.columns, *[v for row in self.data for v in row.values()]]:
            if isinstance(value, str) and any(token in value for token in ("{{", "{%", "{#")):
                raise ValueError("Template expressions are not supported in chart snapshots")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Chart numbers must be finite")
        for field in (self.x, self.y, self.color):
            if field is not None and field not in self.columns:
                raise ValueError("Choose chart fields from the result columns")
        if self.chart_type != "table":
            if not self.y:
                raise ValueError("Choose a numeric value column")
            values = [row.get(self.y) for row in self.data if row.get(self.y) is not None]
            if not values or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in values):
                raise ValueError("The value column must contain numbers, not text or booleans")
        if self.chart_type not in ("table", "kpi") and not self.x:
            raise ValueError("Choose a category or X-axis column")
        if self.chart_type == "kpi" and len(self.data) != 1:
            raise ValueError("KPI requires exactly one result row; aggregate your SQL first")
        if self.chart_type in ("pie", "donut") and self.y:
            values = [row.get(self.y) for row in self.data if row.get(self.y) is not None]
            if any(v < 0 for v in values) or not any(v > 0 for v in values):
                raise ValueError("Pie and donut values must be non-negative with a positive total")
        return self


def build_board(request: ChartRequest) -> str:
    """Use stable field aliases so dots/brackets in SQL aliases are not Vega paths."""
    names = {column: f"field_{index}" for index, column in enumerate(request.columns)}
    chart = {"type": request.chart_type, "query": "result", "title": request.title}
    if request.chart_type == "kpi":
        chart.pop("title")
        chart.update(value=names[request.y], label=request.title or request.y)
    elif request.chart_type in ("pie", "donut"):
        chart.update(theta=names[request.y], color=names[request.x])
    elif request.chart_type != "table":
        chart.update(x=names[request.x], y=names[request.y], x_label=request.x, y_label=request.y, height=360)
        if request.color:
            chart["color"] = names[request.color]
    if request.chart_type == "table":
        chart["style"] = {"columns": {names[col]: {"label": col} for col in request.columns}}
    elif request.number_format and request.chart_type == "kpi":
        chart["style"] = {"value": {"format": request.number_format}}
    elif request.number_format and request.chart_type in FORMATTED_TYPES:
        # Without a format the engine warns that a currency or percent measure is unformatted.
        chart["style"] = {"number_format": request.number_format}
    board = {
        "theme": request.theme,
        "queries": {"result": {"columns": list(names.values()), "values": [
            [row.get(col) for col in request.columns] for row in request.data
        ]}},
        "charts": {"result": chart},
        "rows": ["result"],
    }
    return yaml.safe_dump(board, allow_unicode=True, sort_keys=False)


async def render_chart(request: ChartRequest) -> dict:
    board = build_board(request)
    return await render_board_yaml(board)


async def render_board_yaml(board: str, *, validate: bool = False) -> dict:
    executable = Path(sys.executable).with_name("dct")
    if not executable.is_file():
        raise RuntimeError("dbt-charts is not installed. Rebuild dbt-runner with the current lockfile.")
    try:
        await asyncio.wait_for(_render_slots.acquire(), timeout=1)
    except TimeoutError as exc:
        raise RuntimeError("Chart renderer is busy. Try again shortly.") from exc
    try:
        with TemporaryDirectory(prefix="dbt-chart-") as directory:
            root = Path(directory)
            (root / "dbt_charts.yml").write_text("{}\n")
            (root / "charts").mkdir()
            (root / "charts" / "result.yml").write_text(board, encoding="utf-8")
            output = root / "result.html"
            env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "LANG") if key in os.environ}
            env.update(DBT_SEND_ANONYMOUS_USAGE_STATS="false", PYTHONIOENCODING="utf-8")
            args = [str(executable), "validate" if validate else "render", "charts/result.yml", "--project-dir", str(root), "--json" if validate else "--diagnostics-json"]
            if not validate:
                args += ["--format", "html", "--output", str(output), "--no-cache"]
            process = await asyncio.create_subprocess_exec(
                *args,
                cwd=root, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=RENDER_TIMEOUT)
            except (TimeoutError, asyncio.CancelledError):
                if process.returncode is None:
                    process.kill()
                await process.communicate()
                raise
            diagnostics = []
            for line in (stderr + stdout).decode(errors="replace").splitlines():
                try:
                    reported = json.loads(line)
                    if isinstance(reported, dict):
                        diagnostics.append(reported)
                except ValueError:
                    pass
            if validate:
                try:
                    report = json.loads(stdout)
                except ValueError:
                    report = [{"message": stderr.decode(errors="replace")[:1000]}]
                return {"valid": process.returncode == 0, "diagnostics": report}
            reported = [diagnostic(item) for item in diagnostics]
            if process.returncode != 0 or not output.exists():
                failure = ValueError("; ".join(item["message"] for item in reported)
                                     or "dbt-charts could not render these fields. Check the chart type and data.")
                failure.diagnostics = reported
                raise failure
            if output.stat().st_size > 12_000_000:
                raise ValueError("Rendered chart is too large. Reduce the query result limit.")
            return {"html": output.read_text(encoding="utf-8"), "yaml": board,
                    "warnings": reported, "renderer": f"dbt-charts {CHART_VERSION}"}
    finally:
        _render_slots.release()
