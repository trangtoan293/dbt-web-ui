"""Every SQL placeholder in an adapter must be given an argument.

A query written with `$1` but called with no arguments fails only at runtime,
against a real database, with asyncpg's "the server expects 1 argument for this
query, 0 were passed". That shipped once already, in
`PostgreSQLAdapter._get_views`, and only surfaced when the table picker first
called extract_schema.

This is a static check, so it needs no database and covers every adapter -
including ones added later.
"""

import ast
import re
import sys
from pathlib import Path

ADAPTERS_DIR = Path(__file__).resolve().parents[1] / "adapters"
sys.path.insert(0, str(ADAPTERS_DIR.parent))

# asyncpg/oracledb query methods that take positional bind arguments after the SQL.
QUERY_METHODS = {"fetch", "fetchrow", "fetchval", "execute", "executemany"}

PLACEHOLDER_RE = re.compile(r"\$(\d+)")


def _string_value(node: ast.AST) -> str | None:
    """The literal text of a SQL argument, when it is a literal at all."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):  # f-string: take the literal parts
        return "".join(
            part.value
            for part in node.values
            if isinstance(part, ast.Constant) and isinstance(part.value, str)
        )
    return None


def _mismatches(path: Path) -> list[str]:
    tree = ast.parse(path.read_text())
    problems = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr not in QUERY_METHODS or not node.args:
            continue
        sql = _string_value(node.args[0])
        if not sql:
            continue
        expected = len({int(n) for n in PLACEHOLDER_RE.findall(sql)})
        # Every argument after the SQL is a bind value; *args counts as "enough".
        supplied = len(node.args) - 1
        if any(isinstance(a, ast.Starred) for a in node.args):
            continue
        if expected > supplied:
            problems.append(
                f"{path.name}:{node.lineno} query uses {expected} placeholder(s) "
                f"but {supplied} argument(s) are passed"
            )
    return problems


def test_no_query_is_missing_its_bind_arguments():
    problems = []
    for path in sorted(ADAPTERS_DIR.glob("*.py")):
        problems.extend(_mismatches(path))
    assert not problems, "\n".join(problems)


def test_the_checker_catches_a_missing_argument(tmp_path):
    """Guard the guard: a checker that never fires protects nothing."""
    broken = tmp_path / "broken_adapter.py"
    broken.write_text(
        'async def go(conn, schema):\n'
        '    return await conn.fetch("""SELECT 1 WHERE s = $1""")\n'
    )
    assert _mismatches(broken), "the placeholder checker failed to spot a missing arg"
