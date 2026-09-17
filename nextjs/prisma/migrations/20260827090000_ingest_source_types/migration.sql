-- Ingest grows beyond "read tables from Postgres or Oracle".
--
-- Four things at once, because they are one feature: an ingest source can now
-- read incrementally, from MySQL, from files, or from a REST API.
--
-- 1. cursor_field / cursor_initial_value - without a cursor every load reads the
--    whole source table. `append` then duplicates it and `merge` only dedupes at
--    the destination, so the source warehouse is read in full either way. dlt
--    pushes `WHERE cursor > last_value` down to the source, so the cursor is
--    what makes a source of any real size loadable at all.
-- 2. source_config - one JSON blob per source type. `tables` stays where it is
--    because every existing row uses it; a filesystem glob or a REST resource
--    list has no column of its own and does not deserve one.
-- 3. source_connection_id becomes nullable - a filesystem source reads a path,
--    and a public API needs no credential. Neither has a connections row.
-- 4. Two new connection types, both read-only sources with no dbt adapter, in
--    the same way `ducklake` is a connection type that dbt never runs against.

ALTER TYPE "ingest_source_type" ADD VALUE IF NOT EXISTS 'rest_api';
ALTER TYPE "ingest_source_type" ADD VALUE IF NOT EXISTS 'filesystem';

ALTER TYPE "connection_type" ADD VALUE IF NOT EXISTS 'mysql';
ALTER TYPE "connection_type" ADD VALUE IF NOT EXISTS 'rest';

ALTER TABLE "ingest_sources"
  ADD COLUMN IF NOT EXISTS "cursor_field" TEXT,
  ADD COLUMN IF NOT EXISTS "cursor_initial_value" TEXT,
  ADD COLUMN IF NOT EXISTS "source_config" JSONB;

ALTER TABLE "ingest_sources"
  ALTER COLUMN "source_connection_id" DROP NOT NULL;
