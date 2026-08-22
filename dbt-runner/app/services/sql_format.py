"""Pretty-print dbt model SQL without destroying its Jinja.

sqlglot is already a dependency and formats SQL well, but it cannot parse
`{{ ref('x') }}` - so each Jinja expression is swapped for an identifier-shaped
placeholder, the SQL is formatted, and the placeholders are put back. Leading
`{{ config(...) }}` lines are not expressions at all, so they are lifted off as
a preamble and re-attached verbatim.

Anything the round trip cannot guarantee is refused rather than guessed at:
formatting that silently drops a `{% if %}` branch would corrupt a model.

ponytail: sqlglot, not sqlfluff. sqlfluff with the dbt templater is the
thorough answer, but it needs a compiled project per lint and takes seconds per
file. Swap it in behind this same function if per-project lint rules are ever
wanted.
"""

import logging
import re
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)

# {{ expression }}, {% statement %}, {# comment #}
_JINJA_RE = re.compile(r"\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\}", re.DOTALL)
_PLACEHOLDER = "__dbtcraft_jinja_{index}__"
_PLACEHOLDER_RE = re.compile(r"__dbtcraft_jinja_(\d+)__")
# A leading line that is only Jinja, a comment, or blank: config blocks and
# header comments, which are not part of any statement.
_PREAMBLE_LINE_RE = re.compile(r"^\s*(\{\{.*\}\}|\{%.*%\}|\{#.*#\}|--.*)?\s*$")

MAX_SQL_CHARS = 200_000


class SqlFormatError(ValueError):
    """Raised when the SQL cannot be formatted safely."""


def _split_preamble(sql: str) -> Tuple[str, str]:
    """Separate leading Jinja/comment lines from the statement body."""
    lines = sql.splitlines()
    index = 0
    while index < len(lines) and _PREAMBLE_LINE_RE.match(lines[index]):
        index += 1
    return "\n".join(lines[:index]), "\n".join(lines[index:])


def _mask(sql: str) -> Tuple[str, List[str]]:
    """Replace every Jinja block with an identifier-shaped placeholder."""
    captured: List[str] = []

    def swap(match: re.Match[str]) -> str:
        captured.append(match.group(0))
        return _PLACEHOLDER.format(index=len(captured) - 1)

    return _JINJA_RE.sub(swap, sql), captured


def _unmask(sql: str, captured: List[str]) -> str:
    def restore(match: re.Match[str]) -> str:
        index = int(match.group(1))
        if index >= len(captured):
            raise SqlFormatError("formatter invented a placeholder")
        return captured[index]

    return _PLACEHOLDER_RE.sub(restore, sql)


def format_sql(sql: str, dialect: str | None = None) -> Dict[str, Any]:
    """Format SQL, keeping Jinja intact.

    Returns {formatted, sql, reason}. `formatted` is False - with the input
    returned unchanged and a reason - whenever the round trip cannot be trusted:
    unparseable SQL, or Jinja that sqlglot moved or dropped.
    """
    if not sql or not sql.strip():
        return {"formatted": False, "sql": sql, "reason": "nothing to format"}
    if len(sql) > MAX_SQL_CHARS:
        return {
            "formatted": False,
            "sql": sql,
            "reason": f"file is larger than {MAX_SQL_CHARS} characters",
        }

    import sqlglot

    preamble, body = _split_preamble(sql)
    if not body.strip():
        return {"formatted": False, "sql": sql, "reason": "no SQL statement found"}

    masked, captured = _mask(body)
    try:
        statements = sqlglot.transpile(
            masked, read=dialect or None, write=dialect or None, pretty=True
        )
    except Exception as exc:
        # Jinja control flow around SQL clauses lands here, which is correct:
        # there is no safe formatting of a statement that is only valid after
        # templating.
        return {"formatted": False, "sql": sql, "reason": f"could not parse: {exc}"}

    if not statements:
        return {"formatted": False, "sql": sql, "reason": "no SQL statement found"}

    rendered = ";\n\n".join(statement.strip() for statement in statements)

    # Every placeholder must come back exactly once. sqlglot rewriting a query
    # can duplicate or drop a subtree, and either would change what the model
    # does once Jinja is rendered.
    found = [int(match) for match in _PLACEHOLDER_RE.findall(rendered)]
    if sorted(found) != list(range(len(captured))):
        return {
            "formatted": False,
            "sql": sql,
            "reason": "formatting would have moved or dropped a Jinja block",
        }

    try:
        restored = _unmask(rendered, captured)
    except SqlFormatError as exc:
        return {"formatted": False, "sql": sql, "reason": str(exc)}

    parts = [part for part in (preamble.strip(), restored.strip()) if part]
    return {"formatted": True, "sql": "\n\n".join(parts) + "\n", "reason": None}


def demo() -> None:
    """Self-check: the cases that must hold for this to be safe to bind to a key."""
    plain = format_sql("select a,b from t where a=1")
    assert plain["formatted"], plain
    assert "SELECT" in plain["sql"]

    model = format_sql(
        "{{ config(materialized='table') }}\nselect a, b from {{ ref('stg_x') }} where a > 1"
    )
    assert model["formatted"], model
    assert "{{ config(materialized='table') }}" in model["sql"]
    assert "{{ ref('stg_x') }}" in model["sql"]
    assert "__dbtcraft_jinja" not in model["sql"]

    # Jinja control flow wrapping clauses is refused, not mangled.
    control_flow = format_sql(
        "select * from t\n{% if var('x') %} where a = 1 {% else %} where a = 2 {% endif %}"
    )
    assert "{% if var('x') %}" in control_flow["sql"]
    if control_flow["formatted"]:
        assert "{% else %}" in control_flow["sql"], control_flow

    broken = format_sql("select from where")
    assert not broken["formatted"], broken
    assert broken["sql"] == "select from where"

    print("sql_format demo: ok")


if __name__ == "__main__":
    demo()
