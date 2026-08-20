CREATE TABLE "python_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "owner" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT NOT NULL,
    "file_path" TEXT,
    "code_snapshot" TEXT,
    "timeout_seconds" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "duration_ms" BIGINT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "python_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "python_run_files" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "is_binary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "python_run_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "python_run_artifacts" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "artifact_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "previewable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "python_run_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "python_runs_project_id_created_at_idx" ON "python_runs"("project_id", "created_at");
CREATE INDEX "python_runs_owner_project_id_idx" ON "python_runs"("owner", "project_id");
CREATE INDEX "python_run_files_run_id_idx" ON "python_run_files"("run_id");
CREATE INDEX "python_run_artifacts_run_id_idx" ON "python_run_artifacts"("run_id");

ALTER TABLE "python_runs"
    ADD CONSTRAINT "python_runs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "python_runs"
    ADD CONSTRAINT "python_runs_owner_fkey"
    FOREIGN KEY ("owner") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "python_run_files"
    ADD CONSTRAINT "python_run_files_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "python_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "python_run_artifacts"
    ADD CONSTRAINT "python_run_artifacts_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "python_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
