-- Trim the schema to the features the application actually ships.
--
-- Dropped: flow orchestration, the Python execution plane, the never-built
-- AI-chat and manifest-cache tables, and a leftover todo list from the project
-- template. None of these tables were read or written by application code.

-- Flow orchestration (child tables first).
DROP TABLE IF EXISTS "flow_audit_events" CASCADE;
DROP TABLE IF EXISTS "flow_task_runs" CASCADE;
DROP TABLE IF EXISTS "flow_runs" CASCADE;
DROP TABLE IF EXISTS "flows" CASCADE;

-- Python execution plane.
DROP TABLE IF EXISTS "python_run_artifacts" CASCADE;
DROP TABLE IF EXISTS "python_run_files" CASCADE;
DROP TABLE IF EXISTS "python_runs" CASCADE;

-- AI chat (never implemented).
DROP TABLE IF EXISTS "chat_messages" CASCADE;
DROP TABLE IF EXISTS "chat_conversations" CASCADE;
DROP TABLE IF EXISTS "prompt_templates" CASCADE;
DROP TABLE IF EXISTS "ai_configs" CASCADE;

-- Manifest cache tables. Lineage is served from dbt's manifest.json at
-- request time, so these were written by nothing. The two functions read
-- dbt_models, so they must go with it or they are left broken.
DROP FUNCTION IF EXISTS get_upstream_models(text, uuid);
DROP FUNCTION IF EXISTS get_downstream_models(text, uuid);
DROP TABLE IF EXISTS "dbt_model_columns" CASCADE;
DROP TABLE IF EXISTS "dbt_models" CASCADE;

-- Unused view: no code selects from it.
DROP VIEW IF EXISTS recent_runs;

-- dbt_run_artifacts.model_id pointed at dbt_models and was never populated.
ALTER TABLE "dbt_run_artifacts" DROP COLUMN IF EXISTS "model_id";

-- Project-template leftover.
DROP TABLE IF EXISTS "todo_list" CASCADE;

-- Unused NOTIFY trigger: run streaming uses Redis pub/sub, and nothing ever
-- issued LISTEN dbt_run_changed.
DROP TRIGGER IF EXISTS trigger_dbt_runs_notify ON "dbt_runs";
DROP FUNCTION IF EXISTS dbt_runs_notify();

-- Narrow connection_type to the adapters bundled in the dbt-runner image.
-- Rows using a removed type could never run dbt (no adapter was installed),
-- so they are dropped rather than migrated.
DELETE FROM "connections"
WHERE "connection_type"::text IN ('snowflake', 'bigquery', 'redshift', 'databricks');

ALTER TYPE "connection_type" RENAME TO "connection_type_old";
CREATE TYPE "connection_type" AS ENUM ('postgresql', 'duckdb', 'dremio', 'oracle', 'spark');
ALTER TABLE "connections"
  ALTER COLUMN "connection_type" TYPE "connection_type"
  USING "connection_type"::text::"connection_type";
DROP TYPE "connection_type_old";

-- The stored value is a standard OIDC `sub` claim, not a Keycloak-specific id.
ALTER TABLE "users" RENAME COLUMN "keycloak_sub" TO "oidc_sub";
