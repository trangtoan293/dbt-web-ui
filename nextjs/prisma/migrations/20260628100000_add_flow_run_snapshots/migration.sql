-- Immutable Flow run snapshots.
--
-- Each Flow run must execute against the Flow definition that existed when it
-- was triggered. Without this, editing a Flow can change pending tasks in an
-- already-running Flow run.

ALTER TABLE "flows" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "flow_runs" ADD COLUMN "definition_snapshot" JSONB;
ALTER TABLE "flow_runs" ADD COLUMN "flow_version" INTEGER NOT NULL DEFAULT 1;

UPDATE "flow_runs" fr
SET "definition_snapshot" = f."definition",
    "flow_version" = f."version"
FROM "flows" f
WHERE fr."flow_id" = f."id"
  AND fr."definition_snapshot" IS NULL;

ALTER TABLE "flow_runs" ALTER COLUMN "definition_snapshot" SET NOT NULL;
