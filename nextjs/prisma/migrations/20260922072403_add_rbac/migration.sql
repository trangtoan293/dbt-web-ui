/*
  Warnings:

  - You are about to drop the `orchestrator_health_signals` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('admin', 'contributor', 'viewer');

-- CreateEnum
CREATE TYPE "project_permission_level" AS ENUM ('view', 'edit');

-- DropIndex
DROP INDEX "dbt_projects_lakehouse_connection_id_idx";

-- AlterTable
ALTER TABLE "connections" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "dbt_environment_variables" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "dremio_sources" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "git_credentials" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'contributor',
ALTER COLUMN "id" DROP DEFAULT;

-- DropTable
DROP TABLE "orchestrator_health_signals";

-- CreateTable
CREATE TABLE "project_permissions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "level" "project_permission_level" NOT NULL,
    "granted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_permissions_user_id_idx" ON "project_permissions"("user_id");

-- CreateIndex
CREATE INDEX "project_permissions_project_id_idx" ON "project_permissions"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_permissions_project_id_user_id_key" ON "project_permissions"("project_id", "user_id");

-- AddForeignKey
ALTER TABLE "project_permissions" ADD CONSTRAINT "project_permissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "dbt_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_permissions" ADD CONSTRAINT "project_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_permissions" ADD CONSTRAINT "project_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "users_keycloak_sub_key" RENAME TO "users_oidc_sub_key";

-- Backfill: preserve current access exactly. Every existing project keeps
-- working for exactly the person who created it - nobody gains access to a
-- project they could not already reach, nobody loses access to their own.
-- See docs/rbac-design.md section 1.3.
INSERT INTO "project_permissions" (id, project_id, user_id, level, granted_by, created_at, updated_at)
SELECT gen_random_uuid(), id, created_by, 'edit', created_by, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "dbt_projects"
WHERE deleted_at IS NULL;
