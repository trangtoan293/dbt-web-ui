-- Add keycloak_sub column (nullable first)
ALTER TABLE "users" ADD COLUMN "keycloak_sub" TEXT;

-- Copy existing id values into keycloak_sub (id currently stores the Keycloak sub)
UPDATE "users" SET "keycloak_sub" = "id"::TEXT;

-- Make keycloak_sub NOT NULL and unique
ALTER TABLE "users" ALTER COLUMN "keycloak_sub" SET NOT NULL;
CREATE UNIQUE INDEX "users_keycloak_sub_key" ON "users"("keycloak_sub");

-- Set id default to auto-generated UUID
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
