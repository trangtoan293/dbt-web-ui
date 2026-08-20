-- CreateEnum
CREATE TYPE "run_command" AS ENUM ('run', 'test', 'build', 'compile', 'docs', 'deps', 'clean', 'seed', 'snapshot');

-- CreateEnum
CREATE TYPE "connection_type" AS ENUM ('postgresql', 'duckdb', 'dremio', 'snowflake', 'bigquery', 'redshift', 'databricks');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_configs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "owner" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "base_url" TEXT,
    "api_key" TEXT,
    "model_name" TEXT,
    "extra_headers" JSONB,

    CONSTRAINT "ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "owner" UUID NOT NULL,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "parent_id" BIGINT,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "template_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "description" TEXT,
    "owner" UUID NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dremio_sources" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "catalog" TEXT NOT NULL DEFAULT '',
    "arrow_flight_port" INTEGER NOT NULL DEFAULT 32010,
    "created_by" UUID NOT NULL,

    CONSTRAINT "dremio_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dbt_projects" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "git_url" TEXT,
    "git_branch" TEXT DEFAULT 'main',
    "git_project_subdirectory" TEXT DEFAULT '',
    "staging_dir" TEXT,
    "marts_dir" TEXT,
    "sync_status" TEXT DEFAULT 'not_synced',
    "dremio_source_id" UUID,
    "connection_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,

    CONSTRAINT "dbt_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dbt_models" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "unique_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "depends_on" JSONB,
    "columns" JSONB,
    "raw_code" TEXT,
    "compiled_code" TEXT,
    "meta" JSONB,
    "tags" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dbt_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dbt_model_columns" (
    "id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "data_type" TEXT,
    "description" TEXT,
    "tests" JSONB,
    "meta" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dbt_model_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dbt_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "command" "run_command" NOT NULL DEFAULT 'run',
    "selector" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "duration_ms" BIGINT,
    "models_total" INTEGER DEFAULT 0,
    "models_success" INTEGER DEFAULT 0,
    "models_error" INTEGER DEFAULT 0,
    "logs" TEXT,
    "error_message" TEXT,
    "results" JSONB,
    "git_commit" VARCHAR(40),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dbt_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dbt_run_artifacts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "model_id" UUID,
    "unique_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "execution_time" DOUBLE PRECISION,
    "compiled_code" TEXT,
    "error" TEXT,
    "timing" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dbt_run_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connections" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "connection_type" "connection_type" NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_encrypted" TEXT,
    "ssl_mode" TEXT DEFAULT 'prefer',
    "extra_config" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "todo_list" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "done_at" TIMESTAMPTZ,
    "owner" UUID NOT NULL,

    CONSTRAINT "todo_list_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "dremio_sources_name_created_by_key" ON "dremio_sources"("name", "created_by");

-- CreateIndex
CREATE INDEX "dbt_models_depends_on_idx" ON "dbt_models" USING GIN ("depends_on");

-- CreateIndex
CREATE INDEX "dbt_models_tags_idx" ON "dbt_models" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "dbt_models_project_id_unique_id_key" ON "dbt_models"("project_id", "unique_id");

-- CreateIndex
CREATE INDEX "dbt_model_columns_model_id_idx" ON "dbt_model_columns"("model_id");

-- CreateIndex
CREATE INDEX "dbt_runs_project_id_created_at_idx" ON "dbt_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "dbt_run_artifacts_run_id_idx" ON "dbt_run_artifacts"("run_id");

-- AddForeignKey
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_owner_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_owner_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_owner_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dremio_sources" ADD CONSTRAINT "dremio_sources_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_projects" ADD CONSTRAINT "dbt_projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_projects" ADD CONSTRAINT "dbt_projects_dremio_source_id_fkey" FOREIGN KEY ("dremio_source_id") REFERENCES "dremio_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_projects" ADD CONSTRAINT "dbt_projects_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_models" ADD CONSTRAINT "dbt_models_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_model_columns" ADD CONSTRAINT "dbt_model_columns_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "dbt_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_runs" ADD CONSTRAINT "dbt_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_run_artifacts" ADD CONSTRAINT "dbt_run_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "dbt_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dbt_run_artifacts" ADD CONSTRAINT "dbt_run_artifacts_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "dbt_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_list" ADD CONSTRAINT "todo_list_owner_fkey" FOREIGN KEY ("owner") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================
-- Custom SQL: Triggers, Functions, Views
-- =============================================

-- Trigger function: auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_dbt_projects_updated_at
    BEFORE UPDATE ON dbt_projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_dremio_sources_updated_at
    BEFORE UPDATE ON dremio_sources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_connections_updated_at
    BEFORE UPDATE ON connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Recursive function: get upstream models (dependencies)
CREATE OR REPLACE FUNCTION get_upstream_models(
    model_unique_id TEXT,
    project_uuid UUID
)
RETURNS TABLE(unique_id TEXT, name TEXT, resource_type TEXT, path TEXT, level INT) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE upstream AS (
        SELECT m.unique_id, m.name, m.resource_type, m.path, 0 AS level
        FROM dbt_models m
        WHERE m.unique_id = model_unique_id AND m.project_id = project_uuid
        UNION
        SELECT m.unique_id, m.name, m.resource_type, m.path, u.level + 1
        FROM dbt_models m
        JOIN upstream u ON m.unique_id = ANY (SELECT jsonb_array_elements_text(m.depends_on->'nodes'))
        WHERE m.project_id = project_uuid AND u.level < 10
    )
    SELECT DISTINCT u.unique_id, u.name, u.resource_type, u.path, u.level
    FROM upstream u WHERE u.level > 0
    ORDER BY u.level;
END;
$$ LANGUAGE plpgsql;

-- Recursive function: get downstream models (dependents)
CREATE OR REPLACE FUNCTION get_downstream_models(
    model_unique_id TEXT,
    project_uuid UUID
)
RETURNS TABLE(unique_id TEXT, name TEXT, resource_type TEXT, path TEXT, level INT) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE downstream AS (
        SELECT m.unique_id, m.name, m.resource_type, m.path, 0 AS level
        FROM dbt_models m
        WHERE m.unique_id = model_unique_id AND m.project_id = project_uuid
        UNION
        SELECT m.unique_id, m.name, m.resource_type, m.path, d.level + 1
        FROM dbt_models m
        JOIN downstream d ON d.unique_id = ANY (SELECT jsonb_array_elements_text(m.depends_on->'nodes'))
        WHERE m.project_id = project_uuid AND d.level < 10
    )
    SELECT DISTINCT d.unique_id, d.name, d.resource_type, d.path, d.level
    FROM downstream d WHERE d.level > 0
    ORDER BY d.level;
END;
$$ LANGUAGE plpgsql;

-- View: recent runs with project info
CREATE VIEW recent_runs AS
SELECT
    r.id,
    r.project_id,
    p.name AS project_name,
    r.command,
    r.selector,
    r.status,
    r.started_at,
    r.completed_at,
    r.duration_ms,
    r.models_total,
    r.models_success,
    r.models_error,
    r.error_message,
    r.git_commit,
    r.created_at
FROM dbt_runs r
JOIN dbt_projects p ON r.project_id = p.id
WHERE p.deleted_at IS NULL
ORDER BY r.created_at DESC;

-- Trigger: notify on dbt_runs changes (for Phase 7 SSE)
CREATE OR REPLACE FUNCTION dbt_runs_notify()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('dbt_run_changed', json_build_object(
        'run_id', NEW.id,
        'project_id', NEW.project_id,
        'status', NEW.status
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_dbt_runs_notify
    AFTER INSERT OR UPDATE ON dbt_runs
    FOR EACH ROW EXECUTE FUNCTION dbt_runs_notify();
