#!/usr/bin/env bash
#
# The deep path: create a project, dbt init it, walk the file tree, compile and
# run a model against DuckDB, then read the persisted run back out of history.
# Cleans up the project and connection it creates.
#
#   docker compose up -d --wait
#   ./scripts/smoke-dbt.sh
#
# Each run uses its own DuckDB file: DuckDB allows a single writer and the warm
# worker pool holds the file open, so a shared path would fail on the lock.
# Run it from the repository root.

set -uo pipefail
FE=http://127.0.0.1:3000
JAR=$(mktemp); PASS=0; FAIL=0
STAMP=$$
DB=/tmp/dbt-projects/e2e_$STAMP.duckdb
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
contains(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1 — no '$2' in: $(printf '%.240s' "$3")";; esac; }
jq_(){ python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print('PARSE_ERROR', e); raise SystemExit
print($1)"; }

csrf=$(curl -s -c $JAR -b $JAR $FE/api/auth/csrf | jq_ 'd["csrfToken"]')
curl -s -o /dev/null -c $JAR -b $JAR -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$csrf" --data-urlencode "callbackUrl=$FE/" \
  $FE/api/auth/callback/credentials
api(){ curl -s -b $JAR -H 'Content-Type: application/json' "$@"; }

head_ "1. A DuckDB connection"
conn=$(api -X POST -d '{"connectionType":"duckdb","name":"e2e-warehouse-'"$STAMP"'","host":"localhost","port":0,"database":"'"$DB"'","username":"e2e"}' $FE/api/connections)
conn_id=$(echo "$conn" | jq_ 'd.get("id","")')
[ -n "$conn_id" ] && ok "connection created ($conn_id)" || bad "no connection id: $conn"

head_ "2. Create the project"
proj=$(api -X POST -d "{\"name\":\"e2e_pipeline_$STAMP\",\"gitBranch\":\"main\",\"syncStatus\":\"pending\",\"connectionId\":\"$conn_id\"}" $FE/api/projects)
proj_id=$(echo "$proj" | jq_ 'd.get("id","")')
[ -n "$proj_id" ] && ok "project created ($proj_id)" || bad "no project id: $proj"
[ -z "$proj_id" ] && { echo "cannot continue"; exit 1; }

head_ "3. dbt init through the proxy"
init=$(api -X POST -d "{\"project_id\":\"$proj_id\",\"project_name\":\"e2e_pipeline_$STAMP\"}" $FE/api/dbt-runner/dbt/init)
contains "dbt init reported success" '"success":true' "$init"

head_ "4. dbt scaffolded real files"
files=$(api "$FE/api/dbt-runner/files/$proj_id")
contains "dbt_project.yml exists" "dbt_project.yml" "$files"
contains "listing uses the items shape" '"items"' "$files"
contains "models/ exists" "models" "$files"

head_ "5. Compile a model"
# The listing is one level deep, so walk down to the scaffolded models.
model=$(api "$FE/api/dbt-runner/files/$proj_id?path=models/example" | python3 -c "
import json,sys
items = json.load(sys.stdin).get('items', [])
sql = [i['path'] for i in items if i.get('type') == 'file' and i['path'].endswith('.sql')]
print(sorted(sql)[0] if sql else '')")
if [ -n "$model" ]; then ok "found a model: $model"; else bad "no .sql model found under models/example"; fi

if [ -n "$model" ]; then
  name=$(basename "$model" .sql)
  comp=$(api -X POST -d "{\"project_id\":\"$proj_id\",\"model_path\":\"$model\"}" $FE/api/dbt-runner/dbt/compile)
  contains "compile returned SQL" "select" "$(echo "$comp" | tr 'A-Z' 'a-z')"

  head_ "6. dbt run against DuckDB"
  run=$(api -X POST -d "{\"project_id\":\"$proj_id\",\"command\":\"run\",\"args\":\"--select $name\"}" $FE/api/dbt-runner/dbt/command)
  contains "run completed" '"success":true' "$run"
  contains "dbt logged the model" "$name" "$run"
fi

head_ "7. Run history persisted"
runs=$(api "$FE/api/runs?projectId=$proj_id")
contains "history has a run row" '"command"' "$runs"

head_ "8. Cleanup"
del=$(api -X DELETE "$FE/api/projects?id=$proj_id&hard=true")
contains "project hard-deleted" '"success"' "$del"
api -X DELETE "$FE/api/connections?id=$conn_id&type=connection" >/dev/null

rm -f $JAR
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
