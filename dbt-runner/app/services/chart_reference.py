"""Samples and the YAML reference shipped inside the pinned dbt-charts package.

Serving the package's own files keeps the in-app guide in step with the engine
that renders the board, instead of a hand-written copy that drifts on upgrade.
"""

import re
from functools import lru_cache
from pathlib import Path

import dbt_charts
import yaml

from app.services.boards import explore_restrictions
from app.services.charts import CHART_VERSION

# ponytail: layout of the installed package, which uv.lock pins.
PACKAGE = Path(dbt_charts.__file__).resolve().parent


def _examples() -> list[dict]:
    root = PACKAGE / "ai" / "examples"
    examples = []
    for file in sorted(root.rglob("*.yml")) if root.is_dir() else []:
        content = file.read_text(encoding="utf-8")
        board = yaml.safe_load(content)
        board = board if isinstance(board, dict) else {}
        examples.append({
            "slug": file.relative_to(root).with_suffix("").as_posix(),
            "title": str(board.get("title") or file.stem),
            "notes": str(board.get("notes") or "").strip(),
            "yaml": content,
        })
    return examples


def _topics() -> list[dict]:
    source = PACKAGE / "DBT_CHARTS_SYNTAX.md"
    if not source.is_file():
        return []
    topics = []
    for section in source.read_text(encoding="utf-8").split("\n## ")[1:]:
        title, _, body = section.partition("\n")
        topics.append({"slug": re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-"),
                       "title": title.strip(), "body": body.strip()})
    return topics


@lru_cache(maxsize=1)
def reference() -> dict:
    """Read once: the files ship with the image and cannot change while it runs.

    The package's own topics document its CLI (`dct validate`) and a project
    `dbt_charts.yml`. Explore has neither, so the subset it does accept travels
    with them - otherwise a reader follows the docs into files that do not
    exist here.
    """
    return {
        "renderer": f"dbt-charts {CHART_VERSION}",
        "examples": _examples(),
        "topics": _topics(),
        "explore_subset": explore_restrictions(),
    }
