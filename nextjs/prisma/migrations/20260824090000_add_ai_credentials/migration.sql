-- The user's own model credential for the dbt assistant. One per user: the
-- assistant runs one provider at a time (AGENT_PROVIDER), and a second row
-- would need a selection rule nothing has.
CREATE TABLE "ai_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'deepseek-official',
    "api_key_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_credentials_user_id_key" ON "ai_credentials"("user_id");

ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
