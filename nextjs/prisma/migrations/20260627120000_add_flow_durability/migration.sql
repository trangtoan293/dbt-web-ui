-- Flow durability hardening.
--
-- 1. Per-task heartbeat so the scheduler's reaper can tell a live long-running
--    task from a worker that crashed mid-task.
-- 2. A partial unique index enforcing at most one active (pending/running) run
--    per flow, replacing the racy SELECT-then-INSERT guard in run_flow.
--
-- NOTE: the partial unique index is not representable in schema.prisma (Prisma
-- has no filtered-index syntax), so it lives only here. Apply migrations with
-- `prisma migrate deploy` in prod; do not run `migrate dev` against prod, as it
-- would flag this index as drift and try to drop it.

ALTER TABLE "flow_task_runs" ADD COLUMN "last_heartbeat_at" TIMESTAMPTZ;

-- Resolve any pre-existing duplicate active runs (keep the newest) so the
-- unique index can be created without error.
UPDATE "flow_runs" SET "status" = 'error', "completed_at" = now()
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id",
               row_number() OVER (PARTITION BY "flow_id" ORDER BY "created_at" DESC) AS rn
        FROM "flow_runs"
        WHERE "status" IN ('pending', 'running')
    ) ranked
    WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX "flow_runs_one_active_per_flow"
    ON "flow_runs"("flow_id") WHERE "status" IN ('pending', 'running');
