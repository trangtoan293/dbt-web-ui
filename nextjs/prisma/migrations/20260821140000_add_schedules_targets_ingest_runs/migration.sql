-- dbt schedules, named per-project targets, and ingest run history.
--
-- Hand-written: `prisma migrate diff` against this dev database also picks up
-- unrelated drift (including a DROP TABLE), same reason as the ingest migration.

-- AlterEnum. `dbt source freshness` is one dbt command, so it is one enum value.
ALTER TYPE "run_command" ADD VALUE IF NOT EXISTS 'source_freshness';

-- CreateTable
CREATE TABLE "project_targets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "connection_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_targets_project_id_idx" ON "project_targets"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_targets_project_id_name_key" ON "project_targets"("project_id", "name");

-- AddForeignKey
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey. RESTRICT: deleting a connection a target still points at must
-- fail loudly, not silently leave the project with a profile it cannot render.
ALTER TABLE "project_targets" ADD CONSTRAINT "project_targets_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "dbt_schedules" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "command" "run_command" NOT NULL DEFAULT 'run',
    "selector" TEXT,
    "target" TEXT,
    "cron" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "webhook_url" TEXT,
    "last_run_at" TIMESTAMPTZ,
    "last_run_id" UUID,
    "last_status" TEXT,
    "next_run_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "dbt_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex. The scheduler's only query is "active and due".
CREATE INDEX "dbt_schedules_is_active_next_run_at_idx" ON "dbt_schedules"("is_active", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "dbt_schedules_project_id_name_key" ON "dbt_schedules"("project_id", "name");

-- AddForeignKey
ALTER TABLE "dbt_schedules" ADD CONSTRAINT "dbt_schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_schedules" ADD CONSTRAINT "dbt_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ingest_runs" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "duration_ms" BIGINT,
    "rows_loaded" INTEGER,
    "tables" JSONB,
    "logs" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingest_runs_source_id_created_at_idx" ON "ingest_runs"("source_id", "created_at");

-- CreateIndex
CREATE INDEX "ingest_runs_project_id_created_at_idx" ON "ingest_runs"("project_id", "created_at");

-- AddForeignKey
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ingest_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
