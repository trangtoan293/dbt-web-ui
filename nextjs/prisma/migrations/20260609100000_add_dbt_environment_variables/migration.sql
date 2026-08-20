CREATE TABLE "dbt_environment_variables" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "owner" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "value_encrypted" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dbt_environment_variables_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dbt_environment_variables_project_id_owner_name_key"
    ON "dbt_environment_variables"("project_id", "owner", "name");

CREATE INDEX "dbt_environment_variables_owner_project_id_idx"
    ON "dbt_environment_variables"("owner", "project_id");

ALTER TABLE "dbt_environment_variables"
    ADD CONSTRAINT "dbt_environment_variables_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dbt_environment_variables"
    ADD CONSTRAINT "dbt_environment_variables_owner_fkey"
    FOREIGN KEY ("owner") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER update_dbt_environment_variables_updated_at
    BEFORE UPDATE ON "dbt_environment_variables"
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
