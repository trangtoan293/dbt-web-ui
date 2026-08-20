CREATE TABLE "flows" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "schedule_cron" TEXT,
    "last_triggered_at" TIMESTAMPTZ,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,
    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_runs" (
    "id" UUID NOT NULL,
    "flow_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "trigger_type" TEXT NOT NULL,
    "params" JSONB,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flow_task_runs" (
    "id" UUID NOT NULL,
    "flow_run_id" UUID NOT NULL,
    "task_key" TEXT NOT NULL,
    "depends_on" TEXT[] NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dbt_run_id" UUID,
    "result" JSONB,
    "sla_breached" BOOLEAN NOT NULL DEFAULT false,
    "sla_breached_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "error_message" TEXT,
    CONSTRAINT "flow_task_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "flows_project_id_idx" ON "flows"("project_id");
CREATE INDEX "flow_runs_flow_id_created_at_idx" ON "flow_runs"("flow_id", "created_at");
CREATE INDEX "flow_task_runs_flow_run_id_idx" ON "flow_task_runs"("flow_run_id");
CREATE UNIQUE INDEX "flow_task_runs_flow_run_id_task_key_key" ON "flow_task_runs"("flow_run_id", "task_key");

ALTER TABLE "flows" ADD CONSTRAINT "flows_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flows" ADD CONSTRAINT "flows_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_fkey"
    FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_task_runs" ADD CONSTRAINT "flow_task_runs_flow_run_id_fkey"
    FOREIGN KEY ("flow_run_id") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
