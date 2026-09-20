-- A schedule can now fire an ingest load, not only a dbt command.
--
-- Until now `dbt_schedules` was dbt-only and the scheduler never started a
-- load, so ingest was manual work forever - which in practice meant the data
-- was never fresh, because nobody presses Run at 03:00. Every platform this was
-- compared against treats the schedule as part of setting up a connector.
--
-- A nullable column on the existing table rather than a second scheduler: this
-- one already has Redis leadership, a UTC croniter, a misfire grace window,
-- `next_run_at` advancing before the run starts, and a webhook that goes
-- through the host guard. None of that is worth writing twice.
--
-- NULL means what it always meant: this schedule runs dbt.
-- A useful consequence: `command` stays meaningful, so a later schedule can run
-- a load and then the dbt build that depends on it.

ALTER TABLE "dbt_schedules"
  ADD COLUMN IF NOT EXISTS "ingest_source_id" UUID
  REFERENCES "ingest_sources"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "dbt_schedules_ingest_source_id_idx"
  ON "dbt_schedules"("ingest_source_id");
