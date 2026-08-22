"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { History, Loader2, Play, Square } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { useIngestStream } from "@/lib/hooks/useIngestStream"
import {
  cancelIngest,
  getIngestDbtSources,
  getIngestRunLogs,
  getIngestRuns,
  type IngestRunRow,
} from "@/lib/api-client"

function formatDuration(ms: number | null): string {
  if (ms === null) return "—"
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

interface Props {
  sourceId: string
  sourceName: string
  writeDisposition: string
}

export default function IngestRunPanel({ sourceId, sourceName, writeDisposition }: Props): React.ReactElement {
  const { logs, running, result, run, stop } = useIngestStream()
  const [fullRefresh, setFullRefresh] = useState(false)
  const [snippet, setSnippet] = useState<string | null>(null)
  const [history, setHistory] = useState<IngestRunRow[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [pastLogs, setPastLogs] = useState<{ id: string; logs: string } | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  const loadHistory = useCallback(async () => {
    try {
      const data = await getIngestRuns(sourceId)
      setHistory(data.items ?? [])
    } catch {
      setHistory([])
    }
  }, [sourceId])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" })
  }, [logs])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // A finished run has just written its row, so refresh rather than guess.
  useEffect(() => {
    if (!running && result) loadHistory()
  }, [loadHistory, result, running])

  async function handleStop() {
    stop()
    // The stream abort only drops this client; ask the runner to kill the job.
    await cancelIngest(sourceId).catch(() => undefined)
  }

  async function showSnippet() {
    try {
      const data = await getIngestDbtSources(sourceId)
      setSnippet(data.content)
    } catch {
      setSnippet(null)
    }
  }

  const rowCounts = result?.type === "completed" ? result.row_counts ?? {} : {}

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => run(sourceId, { fullRefresh })} disabled={running}>
          {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Run ingest
        </Button>
        {running && (
          <Button size="sm" variant="outline" onClick={handleStop}>
            <Square className="mr-2 h-4 w-4" /> Stop
          </Button>
        )}
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={fullRefresh} onChange={(e) => setFullRefresh(e.target.checked)} />
          Full refresh (reset incremental state)
        </label>
        <Button size="sm" variant="outline" onClick={showSnippet}>Show dbt sources.yml</Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setHistoryOpen((open) => !open)
            if (!historyOpen) loadHistory()
          }}
        >
          <History className="mr-2 h-4 w-4" /> History{history.length > 0 ? ` (${history.length})` : ""}
        </Button>
      </div>

      {writeDisposition === "merge" && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Merge upserts on the primary key. If the source adds or removes a column, the load
          fails rather than evolving the schema — re-run with a full refresh after a schema change.
        </p>
      )}

      {(logs.length > 0 || running) && (
        <pre className="max-h-64 overflow-auto rounded-md bg-gray-950 p-3 text-xs leading-5 text-gray-100">
          {logs.join("\n")}
          <div ref={logEndRef} />
        </pre>
      )}

      {result?.type === "error" && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{result.message}</p>
      )}

      {result?.type === "completed" && (
        <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          <p className="font-medium">{sourceName} loaded into {result.dataset}</p>
          {Object.keys(rowCounts).length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs">
              {Object.entries(rowCounts).map(([table, count]) => (
                <li key={table}>{table}: {count.toLocaleString()} rows</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {historyOpen && (
        <div className="rounded-md border border-gray-200">
          {history.length === 0 ? (
            <p className="p-3 text-xs text-gray-500">
              No past loads recorded for this source yet.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Started</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Rows</th>
                  <th className="px-3 py-2 text-right font-medium">Duration</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-3 py-1.5 text-gray-700">
                      {entry.started_at ? new Date(entry.started_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          entry.status === "success"
                            ? "text-emerald-700"
                            : entry.status === "running"
                              ? "text-sky-700"
                              : "text-red-700"
                        }
                      >
                        {entry.status}
                      </span>
                      {entry.error_message && (
                        <span className="ml-1 text-gray-400" title={entry.error_message}>
                          ⓘ
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-700">
                      {entry.rows_loaded === null ? "—" : entry.rows_loaded.toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-700">
                      {formatDuration(entry.duration_ms)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        type="button"
                        className="text-[#0078D4] hover:underline"
                        onClick={async () => {
                          try {
                            const data = await getIngestRunLogs(entry.id)
                            setPastLogs({ id: entry.id, logs: data.logs })
                          } catch {
                            setPastLogs({ id: entry.id, logs: "Logs unavailable." })
                          }
                        }}
                      >
                        Logs
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {pastLogs && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium text-gray-700">Stored log tail</p>
            <button
              type="button"
              className="text-xs text-gray-500 hover:underline"
              onClick={() => setPastLogs(null)}
            >
              Close
            </button>
          </div>
          <pre className="max-h-64 overflow-auto rounded-md bg-gray-950 p-3 text-xs leading-5 text-gray-100">
            {pastLogs.logs || "(empty)"}
          </pre>
        </div>
      )}

      {snippet && (
        <div>
          <p className="mb-1 text-xs font-medium text-gray-700">
            Paste into your dbt project so models can reference these tables:
          </p>
          <pre className="overflow-x-auto rounded-md bg-gray-100 p-3 text-xs">{snippet}</pre>
        </div>
      )}
    </div>
  )
}
