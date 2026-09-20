-- Per-table overrides on one ingest source.
--
-- Until now `cursor_field`, `write_disposition` and `primary_key` were one value
-- each for the whole source, so a load of twelve tables had to agree on one
-- cursor column. In a real warehouse they do not: `UPDATED_AT` on one table,
-- `LAST_MODIFIED` on the next, and a reference table with no change stamp at
-- all. The workaround was one source per table, or no cursor - and a source with
-- no cursor re-reads everything on every run.
--
-- A JSONB column rather than a child table: the keys are table names that are
-- already validated in `tables`, there is nothing to join to, and a NULL here
-- means "every table uses the source-level values", which is exactly what every
-- existing row should keep doing.
--
-- Shape: { "<table>": { "cursorField": "...", "cursorInitialValue": "...",
--                       "writeDisposition": "merge", "primaryKey": ["id"] } }
-- Any key absent falls back to the source-level column of the same name.

ALTER TABLE "ingest_sources" ADD COLUMN IF NOT EXISTS "table_config" JSONB;
