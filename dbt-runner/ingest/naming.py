"""What a source table ends up called in the destination.

dlt normalises every identifier through its `snake_case` naming convention
before writing, so an Oracle table called `CUSTOMER_ADDRESS` lands as
`customer_address`. Anything that names the loaded table afterwards - the
generated `sources.yml`, the row counts, the wizard's preview - has to apply the
same rule or it names a table that does not exist.

An approximation of dlt's convention rather than a call into it: this runs in
the API process, where dlt is not imported, and it only has to agree often
enough to be worth showing. dlt itself remains the thing that decides.
"""

import re

_CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
_NON_IDENTIFIER = re.compile(r"[^A-Za-z0-9]+")


def destination_table_name(source_table: str) -> str:
    """The destination name for one source table."""
    spaced = _CAMEL_BOUNDARY.sub(r"\1_\2", str(source_table or ""))
    return _NON_IDENTIFIER.sub("_", spaced).lower().strip("_")
