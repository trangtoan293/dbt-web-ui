-- Credentials become one row per reference (`apiKeyEnv`), the way the harness
-- keys its own credential store, so a user can hold keys for several providers.
ALTER TABLE "ai_credentials"
    ADD COLUMN "credential_name" TEXT NOT NULL DEFAULT 'DEEPSEEK_API_KEY';

DROP INDEX IF EXISTS "ai_credentials_user_id_key";

CREATE UNIQUE INDEX "ai_credentials_user_id_credential_name_key"
    ON "ai_credentials"("user_id", "credential_name");

-- Provider routes, in the shape the harness's own adapter takes. No secret
-- lives here: a route names the credential it resolves, like `llm-pi-ai` does.
CREATE TABLE "ai_providers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "label" TEXT,
    "api_key_env" TEXT NOT NULL,
    "api" TEXT,
    "base_url" TEXT,
    "models" JSONB,
    "default_model" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_providers_user_id_route_key" ON "ai_providers"("user_id", "route");

ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
