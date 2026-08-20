#!/usr/bin/env bash
# Create the dedicated test database and apply migrations, then write nextjs/.env.test.
#
# Tests (test/setup.ts) wipe EVERY table in beforeEach, so they MUST run against a
# throwaway database — never the dev/prod DB. The "test" substring in the DB name is
# required by the safety guard in test/setup.ts.
#
# Usage:  npm run test:setup
# Override via env: PG_CONTAINER, PGHOST, PGPORT, PGUSER, PGPASSWORD, TEST_DB_NAME.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-dbt-craft-postgres}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5434}"
PGUSER="${PGUSER:-dbtcraft}"
PGPASSWORD="${PGPASSWORD:-devpassword123}"
TEST_DB_NAME="${TEST_DB_NAME:-dbtcraft_test}"

TEST_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${TEST_DB_NAME}"

# psql is run inside the postgres container (no host psql dependency).
psql_in() { docker exec -i "${PG_CONTAINER}" psql -U "${PGUSER}" -d dbtcraft "$@"; }

echo "==> Creating database '${TEST_DB_NAME}' (if absent) via container '${PG_CONTAINER}'"
if ! psql_in -tAc "SELECT 1 FROM pg_database WHERE datname='${TEST_DB_NAME}'" | grep -q 1; then
  psql_in -c "CREATE DATABASE ${TEST_DB_NAME};"
else
  echo "    already exists"
fi

echo "==> Applying migrations to '${TEST_DB_NAME}'"
DATABASE_URL="${TEST_URL}" npx prisma migrate deploy

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.test"
if [ ! -f "${ENV_FILE}" ]; then
  echo "==> Writing ${ENV_FILE}"
  cat > "${ENV_FILE}" <<EOF
# Test-only env (loaded by vitest.config.ts). MUST target a dedicated test database.
DATABASE_URL=${TEST_URL}
EOF
else
  echo "==> ${ENV_FILE} already present, leaving as-is"
fi

echo "==> Done. Run: npm run test"
