import { describe, expect, it } from "vitest"
import {
  filterDbtLogEntries,
  getDbtInvocationMetadata,
  getDbtNodeResults,
  parseDbtLogLine,
  parseDbtLogs,
  timingDurationMs,
  type DbtLogLevel,
} from "@/lib/dbt-run-logs"

describe("dbt run log parsing", () => {
  it("normalizes dbt Core structured JSON events", () => {
    const entry = parseDbtLogLine(JSON.stringify({
      data: { msg: "Running model orders" },
      info: {
        ts: "2026-08-20T10:15:30.123Z",
        level: "warn",
        msg: "Running model orders",
        code: "Q012",
        name: "NodeStart",
        thread: "Thread-2",
        invocation_id: "invocation-1",
      },
    }), 4)

    expect(entry).toMatchObject({
      lineNumber: 4,
      timestamp: "2026-08-20T10:15:30.123Z",
      level: "warn",
      message: "Running model orders",
      code: "Q012",
      eventName: "NodeStart",
      thread: "Thread-2",
      invocationId: "invocation-1",
    })
  })

  it("parses dbt text logs, removes ANSI escapes, and infers severity", () => {
    const entries = parseDbtLogs([
      "21:21:15.273802 [debug] [MainThread]: Partial parsing enabled",
      "12:03:12  1 of 2 OK created view model orders",
      "\u001b[31m12:03:13  2 of 2 ERROR creating model customers\u001b[0m",
    ].join("\n"))

    expect(entries.map((entry) => entry.level)).toEqual(["debug", "success", "error"])
    expect(entries[2].raw).not.toContain("\u001b")
  })

  it("filters by severity and event metadata", () => {
    const entries = parseDbtLogs("INFO starting\nWARN deprecated config\nERROR orders failed")
    const enabled = new Set<DbtLogLevel>(["warn", "error"])

    expect(filterDbtLogEntries(entries, "orders", enabled).map((entry) => entry.lineNumber)).toEqual([3])
    expect(filterDbtLogEntries(entries, "", enabled)).toHaveLength(2)
  })
})

describe("dbt run_results helpers", () => {
  const runResults = {
    metadata: {
      invocation_id: "abc-123",
      dbt_version: "1.10.16",
      generated_at: "2026-08-20T10:00:00Z",
      dbt_schema_version: "https://schemas.getdbt.com/dbt/run-results/v6.json",
    },
    args: { which: "build", target: "prod", threads: 8, fail_fast: true, full_refresh: false },
    elapsed_time: 14.25,
    results: [{ unique_id: "model.shop.orders", status: "success" }],
  }

  it("extracts invocation metadata without trusting arbitrary JSON types", () => {
    expect(getDbtInvocationMetadata(runResults)).toEqual({
      invocationId: "abc-123",
      dbtVersion: "1.10.16",
      generatedAt: "2026-08-20T10:00:00Z",
      schemaVersion: "https://schemas.getdbt.com/dbt/run-results/v6.json",
      elapsedTime: 14.25,
      command: "build",
      target: "prod",
      threads: 8,
      failFast: true,
      fullRefresh: false,
    })
    expect(getDbtNodeResults(runResults)).toHaveLength(1)
  })

  it("calculates compile/execute timing durations", () => {
    expect(timingDurationMs({
      started_at: "2026-08-20T10:00:00.000Z",
      completed_at: "2026-08-20T10:00:01.250Z",
    })).toBe(1250)
    expect(timingDurationMs({ name: "compile" })).toBeNull()
  })
})
