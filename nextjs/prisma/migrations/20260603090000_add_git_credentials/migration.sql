CREATE TABLE "git_credentials" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "owner" UUID NOT NULL,
    "remote_url" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "git_credentials_project_id_owner_remote_url_key"
    ON "git_credentials"("project_id", "owner", "remote_url");

CREATE INDEX "git_credentials_owner_project_id_idx"
    ON "git_credentials"("owner", "project_id");

ALTER TABLE "git_credentials"
    ADD CONSTRAINT "git_credentials_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "git_credentials"
    ADD CONSTRAINT "git_credentials_owner_fkey"
    FOREIGN KEY ("owner") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER update_git_credentials_updated_at
    BEFORE UPDATE ON "git_credentials"
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
