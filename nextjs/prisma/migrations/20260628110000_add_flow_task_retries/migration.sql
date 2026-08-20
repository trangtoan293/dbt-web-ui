-- Per-task retry policy for Flow runs.

ALTER TABLE "flow_task_runs" ADD COLUMN "attempt_number" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "flow_task_runs" ADD COLUMN "max_retries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "flow_task_runs" ADD COLUMN "retry_delay_seconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "flow_task_runs" ADD COLUMN "next_retry_at" TIMESTAMPTZ;

CREATE INDEX "flow_task_runs_retrying_next_retry_at_idx"
    ON "flow_task_runs"("next_retry_at")
    WHERE "status" = 'retrying';
