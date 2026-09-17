-- Give every project that already has a lakehouse a connection row for it.
--
-- The new row's id is deliberately the *project's* id. A managed lake's
-- metadata schema and data directory are derived from the id of the lake, and
-- until now they were derived from the id of the project - so reusing the id
-- makes the derivation produce byte-identical names and nothing has to be
-- stored, renamed or moved. Existing lakes keep working with no data migration.

INSERT INTO "connections" (
  "id", "name", "connection_type", "host", "port", "database", "username",
  "ssl_mode", "extra_config", "is_active", "created_by", "created_at", "updated_at"
)
SELECT DISTINCT
  p."id",
  left(p."name", 40) || ' lakehouse',
  'ducklake'::"connection_type",
  '', 0, '', '',
  NULL,
  '{"mode": "managed", "maintained": true}'::jsonb,
  TRUE,
  p."created_by",
  now(),
  now()
FROM "dbt_projects" p
JOIN "ingest_sources" s
  ON s."project_id" = p."id" AND s."destination" = 'ducklake'
WHERE p."deleted_at" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "dbt_projects" p
SET "lakehouse_connection_id" = p."id"
WHERE p."lakehouse_connection_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "connections" c
    WHERE c."id" = p."id" AND c."connection_type" = 'ducklake'
  );
