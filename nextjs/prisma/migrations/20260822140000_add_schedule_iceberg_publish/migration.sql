-- Lake schema a schedule publishes as Iceberg after a successful run.
--
-- Nullable and null by default: publishing is opt-in per schedule, and an
-- existing schedule must keep behaving exactly as it did.
ALTER TABLE "dbt_schedules" ADD COLUMN IF NOT EXISTS "publish_schema" TEXT;
