"use client"

import React, { useCallback, useEffect, useState } from "react"
import { Loader2, Play, Wand2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import CodeEditor from "@/components-v2/shared/CodeEditor"
import QueryResultsTable from "@/components-v2/develop/workspace/QueryResultsTable"
import { dbtApi } from "@/lib/api"
import { getProjectTargets } from "@/lib/api-client"

const STORAGE_PREFIX = "explore-sql:"
const DEFAULT_SQL = "select 1 as answer"

interface SqlConsoleProps {
  projectId: string
  projectName: string
}

interface Results {
  data: Record<string, unknown>[]
  columns: string[]
  columnTypes?: Record<string, string>
  rowCount: number
  executionTime?: number
}

/**
 * Ad-hoc SQL against the project's own dbt profile.
 *
 * Runs through `dbt show --inline`, which is why it needs no second connection
 * path and why the backend can hold it to read-only SELECT/WITH: the warehouse
 * credentials, macros and target all come from the project's profile.
 */
export default function SqlConsole({
  projectId,
  projectName,
}: SqlConsoleProps): React.ReactElement {
  const [sql, setSql] = useState(DEFAULT_SQL)
  const [limit, setLimit] = useState(100)
  const [running, setRunning] = useState(false)
  const [formatting, setFormatting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [results, setResults] = useState<Results | null>(null)
  const [targets, setTargets] = useState<string[]>([])
  const [target, setTarget] = useState("")

  // Draft SQL survives a tab switch or reload; it is per project, so two
  // projects do not clobber each other's scratchpad.
  useEffect(() => {
    if (typeof window === "undefined") return
    setSql(window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`) ?? DEFAULT_SQL)
    setResults(null)
    setError(null)
  }, [projectId])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, sql)
  }, [projectId, sql])

  useEffect(() => {
    getProjectTargets(projectId)
      .then((rows) => setTargets(rows.map((row) => row.name)))
      .catch(() => setTargets([]))
    setTarget("")
  }, [projectId])

  const run = useCallback(async () => {
    if (!sql.trim()) return
    setRunning(true)
    setError(null)
    setNotice(null)
    try {
      const response = await dbtApi.query(projectId, sql, limit, target || undefined)
      if (!response.success) {
        setResults(null)
        setError(response.error || "Query failed")
        return
      }
      setResults({
        data: response.data ?? [],
        columns: response.columns ?? [],
        columnTypes: response.column_types,
        rowCount: response.row_count ?? (response.data ?? []).length,
        executionTime: response.execution_time,
      })
    } catch (err) {
      setResults(null)
      setError(err instanceof Error ? err.message : "Query failed")
    } finally {
      setRunning(false)
    }
  }, [limit, projectId, sql, target])

  const format = useCallback(async () => {
    if (!sql.trim()) return
    setFormatting(true)
    setNotice(null)
    try {
      const response = await dbtApi.format(sql)
      if (response.formatted) {
        setSql(response.sql)
      } else {
        // Never overwrite the editor with SQL the formatter could not verify.
        setNotice(response.reason ?? "Could not format this SQL")
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Formatting failed")
    } finally {
      setFormatting(false)
    }
  }, [sql])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2">
        <Button size="sm" onClick={run} disabled={running || !sql.trim()}>
          {running ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1.5 h-4 w-4" />
          )}
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={format} disabled={formatting || running}>
          {formatting ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Wand2 className="mr-1.5 h-4 w-4" />
          )}
          Format
        </Button>
        <label className="ml-1 flex items-center gap-1.5 text-xs text-gray-500">
          Limit
          <input
            type="number"
            min={1}
            max={1000}
            value={limit}
            onChange={(event) =>
              setLimit(Math.max(1, Math.min(1000, Number(event.target.value) || 100)))
            }
            className="h-7 w-20 rounded border border-slate-300 px-2 text-xs"
          />
        </label>
        {targets.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            Target
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="h-7 rounded border border-slate-300 px-2 text-xs"
            >
              <option value="">default (dev)</option>
              {targets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="ml-auto truncate text-xs text-gray-400" title={projectName}>
          {projectName} · read-only SELECT
        </span>
      </div>

      {notice && (
        <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {notice}
        </p>
      )}

      <div className="min-h-[12rem] shrink-0 basis-2/5 border-b border-gray-200">
        <CodeEditor value={sql} onChange={(value) => setSql(value ?? "")} onRun={run} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <QueryResultsTable data={[]} columns={[]} error={error} />
        ) : results ? (
          <QueryResultsTable
            data={results.data}
            columns={results.columns}
            columnTypes={results.columnTypes}
            rowCount={results.rowCount}
            executionTime={results.executionTime}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-gray-500">
            {running ? "Running query…" : "Run a SELECT to see results here."}
          </div>
        )}
      </div>
    </div>
  )
}
