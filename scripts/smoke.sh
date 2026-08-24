#!/usr/bin/env bash
#
# Smoke test for a running stack in single-user mode (AUTH_DISABLED=true).
# Every assertion is about behaviour a user would hit, not internal state.
#
#   docker compose up -d --wait
#   set -a; . ./.env; set +a      # POSTGRES_* for the schema checks
#   ./scripts/smoke.sh
#
# Exits non-zero on the first failed assertion group, so it is safe to run in
# CI. Run it from the repository root.

set -uo pipefail

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "POSTGRES_PASSWORD is not set. Run: set -a; . ./.env; set +a" >&2
  exit 2
fi

FE=http://127.0.0.1:3000
BE=http://127.0.0.1:8080
JAR=$(mktemp)
PASS=0
FAIL=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 — expected $2, got $3"; fi
}

contains() { # contains <description> <needle> <haystack>
  case "$3" in *"$2"*) ok "$1";; *) bad "$1 — no '$2' in: $(printf '%.160s' "$3")";; esac
}

absent() { # absent <description> <needle> <haystack>
  case "$3" in *"$2"*) bad "$1 — found '$2'";; *) ok "$1";; esac
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ---------------------------------------------------------------- containers
head_ "1. Containers"
for svc in postgres redis dbt-runner frontend; do
  state=$(docker compose ps --format '{{.Service}} {{.State}}' | awk -v s="$svc" '$1==s{print $2}')
  check "$svc running" "running" "${state:-missing}"
done
migrate=$(docker compose ps -a --format '{{.Service}} {{.ExitCode}}' | awk '$1=="db-migrate"{print $2}')
check "db-migrate exited 0" "0" "${migrate:-missing}"

# ---------------------------------------------------------------- health
head_ "2. Health endpoints"
check "backend /health" "200" "$(code $BE/health)"
check "frontend /login" "200" "$(code $FE/login)"

# ---------------------------------------------------------------- routing
head_ "3. Routing and auth gating"
check "unauthenticated / redirects" "307" "$(code $FE/)"
loc=$(curl -s -o /dev/null -D - "$FE/" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
contains "redirect target is /login" "/login" "$loc"
for p in /v2/app /workflows /docs /v2/app/storage /auth/register; do
  check "unauthenticated $p is gated, not leaked" "307" "$(code "$FE$p")"
done

# ------------------------------------------- Auth.js must never show its own UI
head_ "3b. Auth.js built-in pages never surface"
check "/api/auth/signin redirects to our page" "302" "$(code $FE/api/auth/signin)"
signin_loc=$(curl -s -o /dev/null -D - "$FE/api/auth/signin" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
contains "it points at /login" "/login" "$signin_loc"
absent "no raw provider button anywhere" "Sign in with" "$(curl -sL $FE/api/auth/signin)"
check "/api/auth/error redirects too" "302" "$(code $FE/api/auth/error)"
contains "a known error code becomes a sentence" "not configured for sign-in yet" "$(curl -s "$FE/login?error=Configuration")"
absent "a missing error code says nothing" "Sign-in failed (undefined)" "$(curl -s "$FE/login?error=undefined")"

# ---------------------------------------------------------------- API is 401 JSON, not a redirect
head_ "4. Unauthenticated API returns 401 JSON (not a redirect)"
check "/api/projects unauthenticated" "401" "$(code $FE/api/projects)"
body=$(curl -s "$FE/api/projects")
contains "401 body is JSON" '"error"' "$body"

# ---------------------------------------------------------------- sign in
head_ "5. Single-user sign-in (AUTH_DISABLED=true)"
csrf=$(curl -s -c "$JAR" -b "$JAR" "$FE/api/auth/csrf" | python3 -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])' 2>/dev/null)
if [ -n "${csrf:-}" ]; then ok "got CSRF token"; else bad "could not fetch CSRF token"; fi
signin=$(code -c "$JAR" -b "$JAR" -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$csrf" \
  --data-urlencode "callbackUrl=$FE/" \
  --data-urlencode "json=true" \
  "$FE/api/auth/callback/credentials")
case "$signin" in 200|302) ok "credentials sign-in accepted ($signin)";; *) bad "credentials sign-in returned $signin";; esac
session=$(curl -s -b "$JAR" "$FE/api/auth/session")
contains "session has a user" '"user"' "$session"
contains "session user is the fixed local user" "local@dbt-craft.local" "$session"

# ---------------------------------------------------------------- authenticated app
head_ "6. Removed routes 404 once authenticated"
for p in /v2/app /workflows /docs /v2/app/storage /auth/register /api/todos; do
  check "$p is gone" "404" "$(code -b "$JAR" "$FE$p")"
done

head_ "6b. Authenticated pages render"
# The five workspace sections plus /settings. Runs, Schedules, Connections and
# Sources are tabs of these, not pages of their own.
for path in / /develop /orchestrate /explore /data /settings; do
  check "GET $path" "200" "$(code -b "$JAR" "$FE$path")"
done

head_ "6c. Retired paths still redirect into the section that absorbed them"
# next.config.ts owns the rules and a unit test owns their contents; this only
# proves the built image applies them, so an old bookmark is a redirect (307)
# and not a 404.
for p in /runs /schedules /connections /sources; do
  check "$p redirects" "307" "$(code -b "$JAR" "$FE$p")"
done

# ---------------------------------------------------------------- authenticated API + DB write
head_ "7. Authenticated API and a real DB write"
check "GET /api/projects" "200" "$(code -b "$JAR" "$FE/api/projects")"
conn=$(curl -s -b "$JAR" -X POST -H 'Content-Type: application/json' \
  -d '{"connectionType":"duckdb","name":"e2e-duckdb","host":"localhost","port":0,"database":"/tmp/e2e.duckdb","username":"e2e"}' \
  "$FE/api/connections")
contains "created a duckdb connection" '"id"' "$conn"
list=$(curl -s -b "$JAR" "$FE/api/connections")
contains "connection appears in the list" "e2e-duckdb" "$list"
absent "connection list never leaks passwordEncrypted" "passwordEncrypted" "$list"

# a removed warehouse type must be rejected, not silently stored
rej=$(code -b "$JAR" -X POST -H 'Content-Type: application/json' \
  -d '{"connectionType":"snowflake","name":"e2e-snow","host":"h","port":0,"database":"d","username":"u"}' \
  "$FE/api/connections")
check "snowflake connection rejected with 400" "400" "$rej"

# ---------------------------------------------------------------- backend proxy
head_ "8. dbt-runner through the frontend proxy"
check "proxy reaches the backend" "200" "$(code -b "$JAR" "$FE/api/dbt-runner/health")"
adapters=$(curl -s -b "$JAR" "$FE/api/dbt-runner/connection/adapters")
contains "adapter registry reachable" "postgresql" "$adapters"
for a in duckdb dremio oracle spark; do contains "adapter $a present" "$a" "$adapters"; done
for a in snowflake bigquery redshift trino athena sqlserver mysql; do
  absent "adapter $a gone" "\"$a\"" "$adapters"
done

# ---------------------------------------------------------------- removed backend routes
head_ "9. Removed backend routes are gone"
openapi=$(curl -s "$BE/openapi.json")
for p in /flows /flow-pools /orchestrator/health /python/runs /sse/flow-runs; do
  absent "OpenAPI has no $p" "\"$p" "$openapi"
done
contains "OpenAPI still has /dbt/runs" '"/dbt/runs' "$openapi"

# ---------------------------------------------------------------- no telemetry
head_ "10. No third-party telemetry in the served page"
page=$(curl -s -b "$JAR" "$FE/")
for host in vercel-insights vitals.vercel googletagmanager google-analytics _vercel/insights; do
  absent "page does not reference $host" "$host" "$page"
done

# ---------------------------------------------------------------- sign out
head_ "10b. Sign out"
LOGOUT_JAR=$(mktemp)
cp "$JAR" "$LOGOUT_JAR"
logout_loc=$(curl -s -o /dev/null -D - -b "$LOGOUT_JAR" -c "$LOGOUT_JAR" "$FE/logout" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
# NEXTAUTH_URL is the configured public URL and outranks the request host, so
# assert it is a browser-usable origin rather than one specific hostname.
contains "logout redirects to the configured public origin" ":3000/login" "$logout_loc"
absent "not to the container bind address" "0.0.0.0" "$logout_loc"
contains "and flags the sign-out" "signedOut=1" "$logout_loc"
check "session is gone" "null" "$(curl -s -b "$LOGOUT_JAR" "$FE/api/auth/session")"
check "/ is gated again" "307" "$(code -b "$LOGOUT_JAR" "$FE/")"
signed_out_page=$(curl -s -b "$LOGOUT_JAR" "$FE/login?signedOut=1")
contains "the page says so" "signed out" "$signed_out_page"
absent "and does not sign straight back in" "Opening your workspace" "$signed_out_page"
rm -f "$LOGOUT_JAR"

# ---------------------------------------------------------------- schema
head_ "11. Database schema matches the trim"
psql() { docker compose exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres psql -U "${POSTGRES_USER:-dbtcraft}" -d "${POSTGRES_DB:-dbtcraft}" -tAc "$1" 2>/dev/null | tr -d ' \r'; }
for t in flows flow_runs flow_task_runs flow_audit_events python_runs python_run_files \
         python_run_artifacts chat_messages chat_conversations prompt_templates ai_configs \
         dbt_models dbt_model_columns todo_list; do
  check "table $t dropped" "f" "$(psql "SELECT to_regclass('public.$t') IS NOT NULL")"
done
check "users.oidc_sub exists" "t" "$(psql "SELECT count(*)=1 FROM information_schema.columns WHERE table_name='users' AND column_name='oidc_sub'")"
check "users.keycloak_sub gone" "t" "$(psql "SELECT count(*)=0 FROM information_schema.columns WHERE table_name='users' AND column_name='keycloak_sub'")"
check "dbt_run_artifacts.model_id gone" "t" "$(psql "SELECT count(*)=0 FROM information_schema.columns WHERE table_name='dbt_run_artifacts' AND column_name='model_id'")"
check "connection_type has 5 values" "5" "$(psql "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='connection_type'")"
check "dbt_runs_notify trigger gone" "t" "$(psql "SELECT count(*)=0 FROM pg_trigger WHERE tgname='trigger_dbt_runs_notify'")"
check "get_upstream_models() gone" "t" "$(psql "SELECT count(*)=0 FROM pg_proc WHERE proname='get_upstream_models'")"
check "get_downstream_models() gone" "t" "$(psql "SELECT count(*)=0 FROM pg_proc WHERE proname='get_downstream_models'")"
check "recent_runs view gone" "t" "$(psql "SELECT count(*)=0 FROM information_schema.views WHERE table_name='recent_runs'")"
check "no function references a dropped table" "t" "$(psql "SELECT count(*)=0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosrc LIKE '%dbt_models%'")"

# ---------------------------------------------------------------- logs
head_ "12. No errors in service logs"
for svc in dbt-runner frontend; do
  errs=$(docker compose logs --no-color "$svc" 2>/dev/null | grep -icE "traceback|unhandled|ERR_MODULE|cannot find module|MODULE_NOT_FOUND" || true)
  check "$svc log has no fatal errors" "0" "$errs"
done

rm -f "$JAR"
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
