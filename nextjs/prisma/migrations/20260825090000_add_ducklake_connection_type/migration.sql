-- A lakehouse becomes a connection.
--
-- `ducklake` is not a warehouse: dbt never runs against it. It is a DuckLake
-- catalog attached alongside a project's warehouse, which is why projects reach
-- it through its own column rather than through connection_id.
--
-- The enum value is added in its own migration because Postgres will not let a
-- value added by ALTER TYPE be *used* in the same transaction. The backfill that
-- inserts rows of this type is the next migration.

ALTER TYPE "connection_type" ADD VALUE IF NOT EXISTS 'ducklake';

ALTER TABLE "dbt_projects"
  ADD COLUMN IF NOT EXISTS "lakehouse_connection_id" UUID;

ALTER TABLE "dbt_projects"
  ADD CONSTRAINT "dbt_projects_lakehouse_connection_id_fkey"
  FOREIGN KEY ("lakehouse_connection_id") REFERENCES "connections"("id")
  ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "dbt_projects_lakehouse_connection_id_idx"
  ON "dbt_projects" ("lakehouse_connection_id");
