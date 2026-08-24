#!/usr/bin/env bash
# Time the same dbt project on two targets, from the app's own run history.
#
#   bench/bench.sh <project_id> <target> [runs]
#
# Runs the project N times against one target and reports the median wall clock
# from dbt_runs - the same number the History tab shows, so the measurement is
# the product's, not a stopwatch beside it.
#
# ponytail: median of N sequential runs, no warmup control beyond N>=3.
# If variance turns out to matter, raise runs before adding statistics.
set -euo pipefail

PROJECT_ID=${1:?usage: bench.sh <project_id> <target> [runs]}
TARGET=${2:?usage: bench.sh <project_id> <target> [runs]}
RUNS=${3:-5}
RUNNER=${DBT_RUNNER_URL:-http://127.0.0.1:8080}
COMMAND=${BENCH_COMMAND:-run}

psql_app() {
  docker compose exec -T postgres psql -qAt -U "${POSTGRES_USER:-dbtcraft}" -d "${POSTGRES_DB:-dbtcraft}" -c "$1"
}

started_after=$(psql_app "select now()")

for i in $(seq 1 "$RUNS"); do
  run_id=$(curl -sf -X POST "$RUNNER/dbt/runs" \
    -H 'Content-Type: application/json' \
    -d "{\"project_id\":\"$PROJECT_ID\",\"command\":\"$COMMAND\",\"target\":\"$TARGET\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("run_id",""))')
  [ -n "$run_id" ] || { echo "run $i: the runner returned no run_id" >&2; exit 1; }

  # Poll rather than stream: only the recorded duration is wanted here.
  for _ in $(seq 1 600); do
    status=$(curl -sf "$RUNNER/dbt/runs/$run_id" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
    case "$status" in
      success|error|cancelled|failed) break ;;
    esac
    sleep 1
  done
  echo "run $i/$RUNS on $TARGET: $status"
done

echo
echo "target=$TARGET command=$COMMAND runs=$RUNS"
psql_app "
  select
    count(*) filter (where status = 'success') as ok,
    count(*) filter (where status <> 'success') as failed,
    round(min(secs), 2)                        as min_s,
    round(percentile_cont(0.5) within group (order by secs)::numeric, 2) as median_s,
    round(max(secs), 2)                        as max_s
  from (
    -- duration_ms is what History shows; it is recorded, not recomputed here.
    select status, duration_ms / 1000.0 as secs
    from dbt_runs
    where project_id = '$PROJECT_ID' and created_at > '$started_after'
  ) t;"
