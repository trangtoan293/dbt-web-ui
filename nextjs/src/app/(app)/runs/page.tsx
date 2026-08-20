"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import { ChevronDown, ChevronRight, RefreshCw, Terminal, Clock, CheckCircle2, XCircle, AlertCircle, Loader2 } from "lucide-react"
import { Card, CardContent } from "@/components-v2/ui/card"
import { getDbtRunnerUrl } from "@/lib/api/client"

type Run = {
  id: string
  projectId: string
  command: string
  selector: string | null
  status: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  modelsTotal: number | null
  modelsSuccess: number | null
  modelsError: number | null
  logs: string | null
  errorMessage: string | null
  gitCommit: string | null
  createdAt: string
  project?: { id: string; name: string }
  _count?: { artifacts: number }
}

type Artifact = {
  id: string
  uniqueId: string
  status: string
  executionTime: number | null
  compiledCode: string | null
  error: string | null
  timing: unknown
}

type DbtRunStreamEvent =
  | { type: "started"; command?: string }
  | { type: "output"; line: string }
  | { type: "completed"; returncode?: number; status?: string }
  | { type: "error"; error: string }
  | { type: "ping" }

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-100 text-blue-700",
  success: "bg-green-100 text-green-700",
  error: "bg-red-100 text-red-700",
  cancelled: "bg-yellow-100 text-yellow-700",
  pending: "bg-gray-100 text-gray-600",
}

const STATUS_ICON: Record<string, React.ReactNode> = {
  running: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  success: <CheckCircle2 className="h-3.5 w-3.5" />,
  error: <XCircle className="h-3.5 w-3.5" />,
  cancelled: <AlertCircle className="h-3.5 w-3.5" />,
  pending: <Clock className="h-3.5 w-3.5" />,
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "-"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.round((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

function formatTime(iso: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  return d.toLocaleString()
}

function shortHash(hash: string | null): string {
  if (!hash) return "-"
  return hash.slice(0, 7)
}

function getFullCommand(run: Run): string {
  return `dbt ${run.command}${run.selector ? ` --select ${run.selector}` : ""}`
}

function getRawCommands(run: Run): string[] {
  const commands = [getFullCommand(run)]
  const logCommands = (run.logs || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(\$ )?dbt\s+/.test(line))
    .map((line) => line.replace(/^\$\s*/, ""))

  for (const command of logCommands) {
    if (!commands.includes(command)) commands.push(command)
  }
  return commands
}

export default function DeployPage() {
  const { data: session, status: sessionStatus } = useSession()
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const expandedIdRef = useRef<string | null>(null)
  const [artifactsByRunId, setArtifactsByRunId] = useState<Record<string, Artifact[]>>({})
  const [artifactsLoadingId, setArtifactsLoadingId] = useState<string | null>(null)
  const [liveLogsByRunId, setLiveLogsByRunId] = useState<Record<string, string[]>>({})

  const fetchRuns = useCallback(async () => {
    if (sessionStatus !== "authenticated" || !session) return
    try {
      setError(null)
      const res = await fetch("/api/runs")
      if (!res.ok) throw new Error((await res.json()).error || "Failed to fetch")
      const data = await res.json()
      setRuns(data)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [session, sessionStatus])

  useEffect(() => {
    if (sessionStatus === "authenticated") {
      fetchRuns()
    } else if (sessionStatus === "unauthenticated") {
      setLoading(false)
      setError("Not authenticated")
    }
  }, [sessionStatus, fetchRuns])

  useEffect(() => {
    if (!expandedId || sessionStatus !== "authenticated") return
    const run = runs.find((item) => item.id === expandedId)
    if (!run || run.status !== "running") return

    const controller = new AbortController()
    const appendLine = (line: string) => {
      setLiveLogsByRunId((prev) => ({
        ...prev,
        [run.id]: [...(prev[run.id] || []), line],
      }))
    }

    ;(async () => {
      try {
        const headers: Record<string, string> = {}
        if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`
        const response = await fetch(`${getDbtRunnerUrl()}/sse/dbt-runs/${run.id}/events`, {
          headers,
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          appendLine(`[ERROR] dbt runner returned ${response.status}`)
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const event = JSON.parse(line.slice(6)) as DbtRunStreamEvent
            if (event.type === "output") appendLine(event.line)
            if (event.type === "error") appendLine(`[ERROR] ${event.error}`)
            if (event.type === "completed") {
              await fetchRuns()
              return
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          appendLine(`[ERROR] ${(error as Error).message}`)
        }
      }
    })()

    return () => controller.abort()
  }, [expandedId, fetchRuns, runs, session?.accessToken, sessionStatus])

  const toggleExpand = async (runId: string) => {
    if (expandedId === runId) {
      setExpandedId(null)
      expandedIdRef.current = null
      return
    }
    setExpandedId(runId)
    expandedIdRef.current = runId
    if (artifactsByRunId[runId]) return

    setArtifactsLoadingId(runId)
    try {
      const res = await fetch(`/api/runs/${runId}`)
      if (!res.ok) throw new Error("Failed to fetch")
      const data = await res.json()
      if (expandedIdRef.current === runId) {
        setArtifactsByRunId((prev) => ({ ...prev, [runId]: data.artifacts || [] }))
      }
    } catch {
      if (expandedIdRef.current === runId) {
        setArtifactsByRunId((prev) => ({ ...prev, [runId]: [] }))
      }
    } finally {
      setArtifactsLoadingId((current) => (current === runId ? null : current))
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">History</h1>
            <p className="text-sm text-gray-500 mt-1">View run history and job status</p>
          </div>
        </div>
        <Card>
          <CardContent className="py-12 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">History</h1>
          <p className="text-sm text-gray-500 mt-1">View run history and job status</p>
        </div>
        <button
          onClick={fetchRuns}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!error && runs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Terminal className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-3 text-sm font-medium text-gray-900">No runs yet</p>
            <p className="mt-1 text-sm text-gray-500">
              Run a dbt command from the Develop tab to see results here.
            </p>
          </CardContent>
        </Card>
      ) : !error ? (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="w-8 px-4 py-3" />
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Project</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Command</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Models</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Duration</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <React.Fragment key={run.id}>
                      <tr
                        className="border-b border-gray-50 hover:bg-gray-50/80 cursor-pointer"
                        onClick={() => toggleExpand(run.id)}
                      >
                        <td className="px-4 py-3">
                          {expandedId === run.id ? (
                            <ChevronDown className="h-4 w-4 text-gray-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-gray-400" />
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-gray-900">
                            {run.project?.name || "—"}
                          </p>
                          {run.gitCommit && (
                            <p className="text-xs text-gray-400 font-mono">{shortHash(run.gitCommit)}</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-sm text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded font-mono">
                            dbt {run.command}
                          </code>
                          {run.selector && (
                            <p className="text-xs text-gray-400 mt-0.5 font-mono">
                              --select {run.selector}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[run.status] || STATUS_STYLES.pending}`}>
                            {STATUS_ICON[run.status] || STATUS_ICON.pending}
                            {run.status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm text-gray-700">
                            {run.modelsSuccess != null ? (
                              <span>
                                <span className="text-green-600 font-medium">{run.modelsSuccess}</span>
                                <span className="text-gray-400"> / </span>
                                <span className="text-red-600 font-medium">{run.modelsError ?? 0}</span>
                                <span className="text-gray-400"> / </span>
                                {run.modelsTotal}
                              </span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm text-gray-600 font-mono">{formatDuration(run.durationMs)}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm text-gray-600">{formatTime(run.startedAt)}</p>
                        </td>
                      </tr>
                      {expandedId === run.id && (
                        <tr key={`${run.id}-detail`}>
                          <td colSpan={7} className="bg-gray-50/50 px-4 py-4">
                            <RunDetail
                              run={run}
                              artifacts={artifactsByRunId[run.id] || []}
                              loading={artifactsLoadingId === run.id}
                              liveLogs={liveLogsByRunId[run.id] || []}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function RunDetail({
  run,
  artifacts,
  loading,
  liveLogs,
}: {
  run: Run
  artifacts: Artifact[]
  loading: boolean
  liveLogs: string[]
}) {
  const rawCommands = getRawCommands(run)
  const logText = liveLogs.length > 0 ? liveLogs.join("\n") : run.logs

  return (
    <div className="space-y-4">
      {/* Run Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-gray-500">Run ID</p>
          <p className="text-sm font-mono text-gray-700 truncate">{run.id.slice(0, 12)}...</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Completed</p>
          <p className="text-sm text-gray-700">{formatTime(run.completedAt)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Full Command</p>
          <code className="text-xs text-gray-700 bg-white px-1.5 py-0.5 rounded font-mono block break-all">
            {getFullCommand(run)}
          </code>
        </div>
        <div>
          <p className="text-xs text-gray-500">Git Commit</p>
          <p className="text-sm font-mono text-gray-700">{shortHash(run.gitCommit)}</p>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Raw Commands
        </p>
        <pre className="rounded-lg border border-gray-200 bg-gray-950 p-3 text-xs text-green-400 font-mono whitespace-pre-wrap">
          {rawCommands.join("\n")}
        </pre>
      </div>

      {/* Error message */}
      {run.errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-xs font-medium text-red-700 mb-1">Error</p>
          <pre className="text-xs text-red-600 whitespace-pre-wrap font-mono">{run.errorMessage}</pre>
        </div>
      )}

      {/* Artifacts */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
          Model Results ({artifacts.length})
        </p>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading artifacts...
          </div>
        ) : artifacts.length === 0 ? (
          <p className="text-sm text-gray-400">No artifacts recorded for this run</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100 bg-white">
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Model</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Time</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">Error</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a) => {
                  const modelName = a.uniqueId.split(".").pop() || a.uniqueId
                  return (
                    <tr key={a.id} className="border-b border-gray-50 bg-white">
                      <td className="px-3 py-2">
                        <p className="text-sm font-mono text-gray-700">{modelName}</p>
                        <p className="text-xs text-gray-400 truncate max-w-[300px]">{a.uniqueId}</p>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[a.status] || STATUS_STYLES.pending}`}>
                          {STATUS_ICON[a.status] || null}
                          {a.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-sm text-gray-600 font-mono">
                        {a.executionTime != null ? `${a.executionTime.toFixed(1)}s` : "-"}
                      </td>
                      <td className="px-3 py-2 text-xs text-red-600 font-mono max-w-[200px] truncate">
                        {a.error || "-"}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Logs */}
      {(logText || run.status === "running") && (
        <details open={run.status === "running"}>
          <summary className="text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700">
            Full Logs
          </summary>
          <pre className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-gray-950 p-3 text-xs text-green-400 font-mono whitespace-pre-wrap">
            {logText || "Waiting for live logs..."}
          </pre>
        </details>
      )}
    </div>
  )
}
