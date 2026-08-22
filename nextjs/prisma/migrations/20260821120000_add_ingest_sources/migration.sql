-- CreateEnum
CREATE TYPE "ingest_source_type" AS ENUM ('sql_database');

-- CreateEnum
CREATE TYPE "ingest_destination" AS ENUM ('connection', 'ducklake');

-- CreateTable
CREATE TABLE "ingest_sources" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_connection_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source_type" "ingest_source_type" NOT NULL DEFAULT 'sql_database',
    "destination" "ingest_destination" NOT NULL DEFAULT 'ducklake',
    "dataset" TEXT NOT NULL,
    "tables" JSONB NOT NULL,
    "write_disposition" TEXT NOT NULL DEFAULT 'append',
    "primary_key" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ingest_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingest_sources_project_id_idx" ON "ingest_sources"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingest_sources_project_id_name_key" ON "ingest_sources"("project_id", "name");

-- AddForeignKey
ALTER TABLE "ingest_sources" ADD CONSTRAINT "ingest_sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey. RESTRICT, not CASCADE: deleting a connection that an ingest
-- source still reads from must fail loudly rather than silently removing the job.
ALTER TABLE "ingest_sources" ADD CONSTRAINT "ingest_sources_source_connection_id_fkey" FOREIGN KEY ("source_connection_id") REFERENCES "connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_sources" ADD CONSTRAINT "ingest_sources_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
