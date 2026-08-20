ALTER TABLE flow_task_runs
ADD COLUMN IF NOT EXISTS pool_name TEXT NOT NULL DEFAULT 'default';

CREATE TABLE IF NOT EXISTS flow_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    flow_run_id UUID,
    event_type TEXT NOT NULL,
    actor_id UUID,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flow_audit_events_flow_created_idx
    ON flow_audit_events(flow_id, created_at);

CREATE INDEX IF NOT EXISTS flow_audit_events_run_idx
    ON flow_audit_events(flow_run_id);

CREATE TABLE IF NOT EXISTS orchestrator_health_signals (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
