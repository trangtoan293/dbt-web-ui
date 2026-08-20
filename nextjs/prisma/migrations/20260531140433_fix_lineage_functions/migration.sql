-- Fix recursive lineage functions: correct JOIN direction in recursive CTE

-- Upstream: walk from target -> models it depends_on -> their dependencies...
DROP FUNCTION IF EXISTS get_upstream_models(TEXT, UUID);
CREATE OR REPLACE FUNCTION get_upstream_models(
    model_unique_id TEXT,
    project_uuid UUID
)
RETURNS TABLE(unique_id TEXT, name TEXT, resource_type TEXT, path TEXT, level INT) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE upstream AS (
        SELECT m.unique_id, m.name, m.resource_type, m.path, m.depends_on, 0 AS level
        FROM dbt_models m
        WHERE m.unique_id = model_unique_id AND m.project_id = project_uuid
        UNION
        SELECT m.unique_id, m.name, m.resource_type, m.path, m.depends_on, u.level + 1
        FROM dbt_models m
        JOIN upstream u ON m.unique_id = ANY (SELECT jsonb_array_elements_text(u.depends_on->'nodes'))
        WHERE m.project_id = project_uuid AND u.level < 10
    )
    SELECT DISTINCT u.unique_id, u.name, u.resource_type, u.path, u.level
    FROM upstream u WHERE u.level > 0
    ORDER BY u.level;
END;
$$ LANGUAGE plpgsql;

-- Downstream: walk from base -> models that depend on it -> their dependents...
DROP FUNCTION IF EXISTS get_downstream_models(TEXT, UUID);
CREATE OR REPLACE FUNCTION get_downstream_models(
    model_unique_id TEXT,
    project_uuid UUID
)
RETURNS TABLE(unique_id TEXT, name TEXT, resource_type TEXT, path TEXT, level INT) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE downstream AS (
        SELECT m.unique_id, m.name, m.resource_type, m.path, 0 AS level
        FROM dbt_models m
        WHERE m.unique_id = model_unique_id AND m.project_id = project_uuid
        UNION
        SELECT m.unique_id, m.name, m.resource_type, m.path, d.level + 1
        FROM dbt_models m
        JOIN downstream d ON d.unique_id = ANY (SELECT jsonb_array_elements_text(m.depends_on->'nodes'))
        WHERE m.project_id = project_uuid AND d.level < 10
    )
    SELECT DISTINCT d.unique_id, d.name, d.resource_type, d.path, d.level
    FROM downstream d WHERE d.level > 0
    ORDER BY d.level;
END;
$$ LANGUAGE plpgsql;
