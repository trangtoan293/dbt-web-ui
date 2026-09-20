"""Propose an incremental cursor for a table the wizard is about to load.

`cursor_field` is the most important field on an ingest source - without one
every run reads the whole source table - and until the form could propose one it
had to be typed from memory. A wrong proposal is cheap, because the field stays
editable; a blank one is not, because nobody goes back to fill it in.

The rule is deliberately narrow: the column must be date-like *and* named like a
change stamp. Guessing from type alone picks `birth_date` on a customer table,
and an incremental load keyed on a birth date silently stops seeing new rows.
"""

from typing import Any, Dict, Iterable, List, Optional

# Best first: an update stamp beats a creation stamp, because a row edited after
# insert is invisible to a cursor on `created_at`.
CURSOR_NAME_HINTS: tuple[str, ...] = (
    "updated_at",
    "modified_at",
    "last_modified",
    "last_updated",
    "last_update",
    "date_modified",
    "updated",
    "modified",
    "changed_at",
    "changed",
    "created_at",
    "inserted_at",
    "date_created",
    "created",
)

# Substrings of the dialect's own type name. `date` also matches `datetime`,
# which is intended - all three are usable as a `WHERE cursor > last_value`.
_DATE_TYPE_HINTS = ("timestamp", "datetime", "date")


def _is_date_like(column: Dict[str, Any]) -> bool:
    return any(hint in str(column.get("type") or "").lower() for hint in _DATE_TYPE_HINTS)


def suggest_cursor(columns: Iterable[Dict[str, Any]]) -> Optional[str]:
    """The column this table should probably track changes on, or None.

    None is a real answer, not a failure: the form says so and lets the user
    accept a full re-read knowingly.
    """
    date_columns = [column for column in columns if _is_date_like(column)]
    for hint in CURSOR_NAME_HINTS:
        for column in date_columns:
            if str(column.get("name") or "").lower() == hint:
                return str(column["name"])
    return None


def suggest_write_disposition(cursor: Optional[str], primary_key: List[str]) -> str:
    """How a table should be updated, given what it can track.

    Kept beside the cursor guess because the two answers come from the same
    facts, and the frontend deriving it separately is one more place to disagree
    with the loader.
    """
    if primary_key:
        # merge needs a key, and with one it is the only disposition that neither
        # duplicates rows nor rewrites the whole table.
        return "merge"
    if cursor:
        return "append"
    # No key and no cursor: appending would duplicate the source on every run.
    return "replace"
