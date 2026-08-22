-- DuckLake partition spec for an ingest source.
--
-- Unpartitioned lake tables mean every query filtering on a date reads every
-- Parquet file in the table. Nullable: existing sources stay unpartitioned, and
-- partitioning only affects writes made after it is set.
ALTER TABLE "ingest_sources" ADD COLUMN IF NOT EXISTS "partition_by" JSONB;
