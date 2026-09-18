"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FilterX,
  Loader2,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react"
import EmptyState from "@/components-v2/shared/EmptyState"
import RunDetail from "@/components-v2/runs/RunDetail"
import RunStatusBadge from "@/components-v2/runs/RunStatusBadge"
import { formatDateTime, formatDuration, getFullCommand, shortHash } from "@/components-v2/runs/formatters"
import type { DbtRun, DbtRunStreamEvent, RunLogDashboardResponse } from "@/components-v2/runs/types"
import { Button } from "@/components-v2/ui/button"
import { Card, CardContent } from "@/components-v2/ui/card"
import { Input } from "@/components-v2/ui/input"
import { getDbtRunnerUrl } from "@/lib/api/client"
import { cn } from "@/lib/utils"

const PAGE_SIZES = [10, 25, 50, 100]
const COMMANDS = ["run", "test", "build", "compile", "docs", "deps", "clean", "seed", "snapshot", "source_freshness"]
const STATUS_OPTIONS = ["running", "error", "success", "cancelled", "pending"]
const EMPTY_DASHBOARD: RunLogDashboardResponse = {
  items: [],
  pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
  summary: { total: 0, success: 0, error: 0, cancelled: 0, running: 0, pending: 0, averageDurationMs: null },
  facets: { projects: [] },
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timeout)
  }, [delay, value])
  return debounced
}

function rangeStart(range: string): string | null {
  const durations: Record<string, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000,
  }
  return durations[range] ? new Date(Date.now() - durations[range]).toISOString() : null
}

function TableSkeleton() {
  return (
    <div className="space-y-1 p-3">
      {Array.from({ length: 7 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[1fr_1.4fr_0.7fr_0.6fr] gap-5 rounded-lg px-3 py-2">
          <div className="h-4 animate-pulse rounded bg-slate-100" />
          <div className="h-4 animate-pulse rounded bg-slate-100" />
          <div className="h-4 animate-pulse rounded bg-slate-100" />
          <div className="h-4 animate-pulse rounded bg-slate-100" />
        </div>
      ))}
    </div>
  )
}

export default function RunsView({ navigation }: { navigation?: React.ReactNode }) {
  const { data: session, status: sessionStatus } = useSession()
  const [dashboard, setDashboard] = useState<RunLogDashboardResponse>(EMPTY_DASHBOARD)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebouncedValue(search, 350)
  const [projectId, setProjectId] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [command, setCommand] = useState("")
  const [range, setRange] = useState("30d")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DbtRun | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [liveLogs, setLiveLogs] = useState<string[]>([])
  const requestSequence = useRef(0)
  const detailRequestSequence = useRef(0)
  const detailRef = useRef<HTMLDivElement>(null)

  const fetchDashboard = useCallback(async (background = false) => {
    if (sessionStatus !== "authenticated") return
    const sequence = ++requestSequence.current
    if (background) setRefreshing(true)
    else setLoading(true)
    try {
      const params = new URLSearchParams({
        view: "logs",
        page: String(page),
        pageSize: String(pageSize),
      })
      if (projectId) params.set("projectId", projectId)
      if (statusFilter) params.set("status", statusFilter)
      if (command) params.set("command", command)
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim())
      const from = rangeStart(range)
      if (from) params.set("from", from)

      const response = await fetch(`/api/runs?${params.toString()}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || "Failed to load dbt run logs")
      if (sequence === requestSequence.current) {
        setDashboard(payload as RunLogDashboardResponse)
        setError(null)
      }
    } catch (fetchError) {
      if (sequence === requestSequence.current) {
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError))
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [command, debouncedSearch, page, pageSize, projectId, range, sessionStatus, statusFilter])

  const fetchDetail = useCallback(async (runId: string, scroll = false) => {
    const sequence = ++detailRequestSequence.current
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await fetch(`/api/runs/${runId}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || "Failed to load run detail")
      if (sequence !== detailRequestSequence.current) return
      setDetail(payload as DbtRun)
      if (scroll) {
        window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }))
      }
    } catch (fetchError) {
      if (sequence === detailRequestSequence.current) {
        setDetailError(fetchError instanceof Error ? fetchError.message : String(fetchError))
      }
    } finally {
      if (sequence === detailRequestSequence.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (sessionStatus === "authenticated") void fetchDashboard(false)
    else if (sessionStatus === "unauthenticated") {
      setLoading(false)
      setError("Not authenticated")
    }
  }, [fetchDashboard, sessionStatus])

  useEffect(() => {
    if (sessionStatus !== "authenticated" || dashboard.summary.running === 0) return
    const interval = window.setInterval(() => void fetchDashboard(true), 5000)
    return () => window.clearInterval(interval)
  }, [dashboard.summary.running, fetchDashboard, sessionStatus])

  useEffect(() => {
    if (!selectedId || detail?.id !== selectedId || detail.status !== "running" || sessionStatus !== "authenticated") return
    const controller = new AbortController()

    const appendLine = (line: string) => {
      setLiveLogs((current) => [...current, line].slice(-10_000))
    }

    void (async () => {
      try {
        const headers: Record<string, string> = {}
        if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`
        const response = await fetch(`${getDbtRunnerUrl()}/sse/dbt-runs/${selectedId}/events`, {
          headers,
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          appendLine(`[ERROR] Unable to attach live logs (HTTP ${response.status})`)
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
          buffer = lines.pop() || ""
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            try {
              const event = JSON.parse(line.slice(6)) as DbtRunStreamEvent
              if (event.type === "output") appendLine(event.line)
              if (event.type === "error") appendLine(`[ERROR] ${event.error}`)
              if (event.type === "completed") {
                await Promise.all([fetchDashboard(true), fetchDetail(selectedId)])
                return
              }
            } catch {
              appendLine(line.slice(6))
            }
          }
        }
      } catch (streamError) {
        if ((streamError as Error).name !== "AbortError") appendLine(`[ERROR] ${(streamError as Error).message}`)
      }
    })()

    return () => controller.abort()
  }, [detail, fetchDashboard, fetchDetail, selectedId, session?.accessToken, sessionStatus])

  const selectRun = (runId: string) => {
    setSelectedId(runId)
    setLiveLogs([])
    void fetchDetail(runId, true)
  }

  const cancelRun = async (runId: string) => {
    const headers: Record<string, string> = {}
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`
    const response = await fetch(`${getDbtRunnerUrl()}/dbt/runs/${runId}/cancel`, { method: "POST", headers })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.detail || payload.message || "Unable to cancel run")
    setLiveLogs((current) => [...current, "[WARN] Cancellation requested by user"])
    await Promise.all([fetchDashboard(true), fetchDetail(runId)])
  }

  const refreshAll = async () => {
    await fetchDashboard(true)
    if (selectedId) await fetchDetail(selectedId)
  }

  const resetFilters = () => {
    setSearch("")
    setProjectId("")
    setStatusFilter("")
    setCommand("")
    setRange("30d")
    setPage(1)
  }

  const setFilter = (setter: (value: string) => void, value: string) => {
    setter(value)
    setPage(1)
  }

  const terminalRuns = dashboard.summary.success + dashboard.summary.error + dashboard.summary.cancelled
  const successRate = terminalRuns > 0 ? (dashboard.summary.success / terminalRuns) * 100 : 0
  const hasFilters = Boolean(search || projectId || statusFilter || command || range !== "30d")
  const rowStart = dashboard.pagination.total === 0 ? 0 : (dashboard.pagination.page - 1) * dashboard.pagination.pageSize + 1
  const rowEnd = Math.min(dashboard.pagination.page * dashboard.pagination.pageSize, dashboard.pagination.total)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
        {navigation}
        <div aria-label="Run summary" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span title="Invocations in the selected time range"><strong className="text-slate-800">{dashboard.summary.total.toLocaleString()}</strong> runs</span>
          <span title="Success rate of terminal runs"><strong className="text-emerald-700">{successRate.toFixed(1)}%</strong> success</span>
          <span title={`${dashboard.summary.cancelled} cancelled`}><strong className="text-red-700">{dashboard.summary.error.toLocaleString()}</strong> failed</span>
          <span title="Average duration of completed invocations"><strong className="text-slate-800">{formatDuration(dashboard.summary.averageDurationMs)}</strong> avg</span>
          {dashboard.summary.running > 0 && <span className="text-blue-700" title="Auto-refresh every 5 seconds">{dashboard.summary.running} running · live</span>}
        </div>
        <Button className="ml-auto" size="sm" variant="ghost" aria-label="Refresh runs" title="Refresh runs" onClick={refreshAll} disabled={refreshing || sessionStatus !== "authenticated"}>
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
      </div>

      <Card>
        <CardContent className="p-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} className="h-8 pl-9 text-xs" placeholder="Search logs, selector, error, project or run ID…" aria-label="Search dbt run logs" />
            </div>
            <select value={projectId} onChange={(event) => setFilter(setProjectId, event.target.value)} className="h-8 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20" aria-label="Filter by project">
              <option value="">All projects</option>
              {dashboard.facets.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <select value={statusFilter} onChange={(event) => setFilter(setStatusFilter, event.target.value)} className="h-8 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-xs capitalize text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20" aria-label="Filter by run status">
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={command} onChange={(event) => setFilter(setCommand, event.target.value)} className="h-8 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20" aria-label="Filter by dbt command">
              <option value="">All commands</option>
              {COMMANDS.map((value) => <option key={value} value={value}>dbt {value}</option>)}
            </select>
            <select value={range} onChange={(event) => setFilter(setRange, event.target.value)} className="h-8 min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-sky-500/20" aria-label="Filter by time range">
              <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="all">All time</option>
            </select>
            <Button size="sm" variant="ghost" onClick={resetFilters} disabled={!hasFilters}><FilterX /> Clear</Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="font-semibold">Could not load run logs</p><p className="mt-0.5">{error}</p></div>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
          <p className="text-xs text-slate-500">{dashboard.pagination.total.toLocaleString()} matching runs · Select a run to inspect logs and results</p>
          {refreshing && <span className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />Updating</span>}
        </div>
        {loading ? <TableSkeleton /> : !error && dashboard.items.length === 0 ? (
          <EmptyState icon={Terminal} title={hasFilters ? "No matching runs" : "No runs yet"} description={hasFilters ? "Adjust or clear the filters to broaden your search." : "Run a dbt command from Develop to start collecting invocation logs and node results."} />
        ) : !error ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px]">
                <thead className="border-b border-slate-200 bg-slate-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr><th className="w-10 px-3 py-2" /><th className="px-3 py-2">Project</th><th className="px-3 py-2">Command</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Node results</th><th className="px-3 py-2">Duration</th><th className="px-3 py-2">Started</th></tr>
                </thead>
                <tbody>
                  {dashboard.items.map((run) => {
                    const selected = selectedId === run.id
                    return (
                      <tr key={run.id} className={cn("border-b border-slate-100 bg-white transition-colors hover:bg-sky-50/40", selected && "bg-sky-50/70")}>
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => selectRun(run.id)} aria-label={`Inspect run ${run.id}`} aria-pressed={selected} className={cn("grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-white hover:text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500/30", selected && "bg-white text-sky-700 shadow-sm")}><ChevronRight className={cn("h-4 w-4 transition-transform", selected && "rotate-90")} /></button>
                        </td>
                        <td className="px-3 py-2">
                          <p className="max-w-48 truncate text-sm font-semibold text-slate-900">{run.project?.name || "Unknown project"}</p>
                          <p className="mt-0.5 font-mono text-xs text-slate-400">{shortHash(run.gitCommit)} · {run.id.slice(0, 8)}</p>
                        </td>
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => selectRun(run.id)} className="max-w-sm text-left">
                            <code className="block truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs font-medium text-slate-700" title={getFullCommand(run)}>dbt {run.command}</code>
                            {run.selector && <p className="mt-1 max-w-sm truncate font-mono text-xs text-slate-400" title={run.selector}>--select {run.selector}</p>}
                          </button>
                        </td>
                        <td className="px-3 py-2"><RunStatusBadge status={run.status} /></td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2 text-xs tabular-nums">
                            <span className="font-semibold text-emerald-700">{run.modelsSuccess ?? 0} passed</span><span className="text-slate-300">/</span><span className={cn("font-semibold", (run.modelsError || 0) > 0 ? "text-red-700" : "text-slate-500")}>{run.modelsError ?? 0} failed</span>
                          </div>
                          <p className="mt-0.5 text-xs text-slate-400">{run.modelsTotal ?? run._count?.artifacts ?? 0} executed</p>
                        </td>
                        <td className="px-3 py-2 font-mono text-sm tabular-nums text-slate-600">{formatDuration(run.durationMs)}</td>
                        <td className="px-3 py-2 text-sm text-slate-600"><span className="block">{formatDateTime(run.startedAt)}</span>{run.errorMessage && <span className="mt-0.5 block max-w-56 truncate text-xs text-red-500" title={run.errorMessage}>{run.errorMessage}</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>Showing {rowStart}–{rowEnd} of {dashboard.pagination.total.toLocaleString()}</span>
                <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }} className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-600" aria-label="Rows per page">
                  {PAGE_SIZES.map((value) => <option key={value} value={value}>{value} / page</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}><ChevronLeft /> Previous</Button>
                <span className="min-w-20 text-center text-xs font-medium text-slate-600">Page {dashboard.pagination.page} of {Math.max(1, dashboard.pagination.totalPages)}</span>
                <Button variant="outline" size="sm" onClick={() => setPage((value) => value + 1)} disabled={page >= dashboard.pagination.totalPages}><ChevronRight /> Next</Button>
              </div>
            </div>
          </>
        ) : null}
      </Card>

      <div ref={detailRef} className="scroll-mt-4">
        {detailLoading && (
          <Card><CardContent className="flex min-h-56 items-center justify-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />Loading invocation detail…</CardContent></Card>
        )}
        {detailError && !detailLoading && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{detailError}</div>
        )}
        {detail && !detailLoading && detail.id === selectedId && (
          <RunDetail run={detail} liveLogs={liveLogs} onCancel={() => cancelRun(detail.id)} />
        )}

      </div>
    </div>
  )
}
