-- Per-Flow trigger behavior when a run is already active.

ALTER TABLE "flows"
ADD COLUMN "concurrency_policy" TEXT NOT NULL DEFAULT 'block';
