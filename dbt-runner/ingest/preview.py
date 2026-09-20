"""The shape of a table preview, shared by every source kind that has one.

A preview is a glance, not a query tool: a fixed handful of rows so the person
filling in the wizard can see what they are about to copy. The row cap lives
here rather than in the request model on purpose - a caller that could ask for
100k rows would have turned a form helper into an unauthenticated export of the
source warehouse.
"""

import datetime
import decimal
from typing import Any

PREVIEW_ROW_LIMIT = 10

# Longest a single cell may be before it is cut. A BLOB or a JSON document in a
# source column would otherwise make one row bigger than the whole response.
MAX_CELL_CHARS = 200


def jsonable(value: Any) -> Any:
    """One source cell, as something `json.dumps` accepts.

    Everything unrecognised becomes its string form: a preview is read by a
    human, and a type this function has never seen is still more useful shown
    than dropped.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return _clip(value) if isinstance(value, str) else value
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(value))} bytes>"
    return _clip(str(value))


def _clip(text: str) -> str:
    return text if len(text) <= MAX_CELL_CHARS else text[:MAX_CELL_CHARS] + "…"
