"use client"

import Link from "next/link"
import React, { useCallback, useEffect, useState } from "react"
import { ArrowRight, Database, Loader2, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import EmptyState from "@/components-v2/shared/EmptyState"
import {
  getIngestMeta,
  getIngestSources,
  getLatestIngestRuns,
  getProjects,
  type IngestSourceRow,
  type LatestIngestRun,
} from "@/lib/api-client"

const DESTINATION_LABELS: Record<string, string> = {
  ducklake: "Lakehouse",
  connection: "Project warehouse",
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  sql_database: "database",
  rest_api: "REST API",
  filesystem: "files",
}

function ago(iso: string | null): string {
  if (!iso) return "never run"
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 90) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

const STATUS_DOT: Record<string, string> = {
  success: "bg-emerald-500",
  running: "bg-sky-500",
  error: "bg-red-500",
  cancelled: "bg-amber-500",
}

/**
 * Every saved load, with the one fact that decides whether to open it: when it
 * last ran and whether that worked.
 *
 * Rows link to a page each rather than expanding in place. An accordion could
 * hold a run panel but not the questions asked between runs - which table moved
 * how many rows, is this even scheduled - and a list of loads is read far more
 * often than it is run from.
 */
export default function SourcesView(): React.ReactElement {
  const [sources, setSources] = useState<IngestSourceRow[]>([])
  const [latest, setLatest] = useState<Record<string, LatestIngestRun>>({})
  const [projects, setProjects] = useState<
    Array<{ id: string; name: string; lakehouseConnectionId?: string | null }>
  >([])
  const [projectFilter, setProjectFilter] = useState("")
  const [metaError, setMetaError] = useState(false)
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const rows = await getIngestSources()
      setSources(Array.isArray(rows) ? rows : [])
      // Freshness is nice to have, not load-bearing: a runner that cannot
      // answer must not blank the list of loads.
      const runs = await getLatestIngestRuns().catch(() => ({ items: [] }))
      setLatest(Object.fromEntries((runs.items ?? []).map((run) => [run.source_id, run])))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load sources")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    getProjects()
      .then((rows) => setProjects(Array.isArray(rows) ? rows : []))
      .catch(() => undefined)
    getIngestMeta().catch(() => setMetaError(true))
  }, [load])

  const needsLakehouse = (source: IngestSourceRow) =>
    source.destination === "ducklake" &&
    !projects.find((project) => project.id === source.projectId)?.lakehouseConnectionId

  const visible = sources.filter(
    (source) =>
      (!projectFilter || source.projectId === projectFilter) &&
      `${source.name} ${source.dataset} ${source.sourceConnection?.name ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )

  const stale = sources.filter((source) => latest[source.id]?.status === "error").length

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-xl border border-slate-200 bg-white py-4">
        {[
          { label: "Saved loads", count: sources.length },
          {
            label: "Ran in the last day",
            count: sources.filter((source) => {
              const at = latest[source.id]?.started_at
              return at ? Date.now() - new Date(at).getTime() < 86_400_000 : false
            }).length,
          },
          { label: "Failing", count: stale },
        ].map((item) => (
          <div key={item.label} className="px-4 sm:px-6">
            <p className="text-xs text-slate-500">{item.label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {loading || error ? "—" : item.count}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          aria-label="Search data loads"
          placeholder="Search loads, sources or schemas…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] sm:max-w-xs"
        />
        <select
          aria-label="Filter by project"
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
          className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={load} disabled={loading} aria-label="Refresh data loads">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button asChild>
            <Link href="/data/loads/new">
              <Plus className="mr-2 h-4 w-4" /> New load
            </Link>
          </Button>
        </div>
      </div>

      {metaError && (
        <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          Source capabilities could not be loaded. Reload this page to check available database
          and file sources.
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : !error && sources.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No data loads"
          description="Create a load to copy database tables, API resources or files into your warehouse or lakehouse."
          action={
            <Button asChild>
              <Link href="/data/loads/new">
                <Plus className="mr-2 h-4 w-4" /> New load
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="hidden grid-cols-[1.3fr_1fr_1.2fr_1fr] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-500 xl:grid">
            <span>Load / project</span>
            <span>Source</span>
            <span>Destination</span>
            <span>Last run</span>
          </div>
          {!visible.length && (
            <p className="p-10 text-center text-sm text-slate-500">
              {error
                ? "Loads are unavailable. Retry to fetch the current list."
                : "No loads match your filters."}
            </p>
          )}
          {visible.map((source) => {
            const run = latest[source.id]
            return (
              <Link
                key={source.id}
                href={`/data/loads/${source.id}`}
                className="grid items-center gap-4 border-b border-slate-100 p-5 last:border-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0078D4] xl:grid-cols-[1.3fr_1fr_1.2fr_1fr]"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium text-slate-900">{source.name}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {projects.find((project) => project.id === source.projectId)?.name ??
                      "Project unavailable"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400 xl:hidden">SOURCE</p>
                  <p className="break-words text-sm text-slate-700">
                    {source.sourceConnection?.name ??
                      SOURCE_TYPE_LABELS[source.sourceType ?? "sql_database"]}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {source.tables.length}{" "}
                    {source.sourceType === "rest_api" ? "resources" : "tables"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400 xl:hidden">DESTINATION</p>
                  <p className="flex items-center gap-1 text-sm text-slate-700">
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    {DESTINATION_LABELS[source.destination]}
                  </p>
                  <p className="mt-1 break-words font-mono text-xs text-slate-500">
                    {source.dataset}
                  </p>
                  {needsLakehouse(source) && (
                    <p className="mt-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">
                      Needs a lakehouse — open to set one up
                    </p>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-slate-400 xl:hidden">LAST RUN</p>
                  <p className="flex items-center gap-2 text-sm text-slate-700">
                    <span
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                        STATUS_DOT[run?.status ?? ""] ?? "bg-slate-300"
                      }`}
                    />
                    {ago(run?.started_at ?? null)}
                  </p>
                  {run?.rows_loaded != null && (
                    <p className="mt-1 text-xs tabular-nums text-slate-500">
                      {run.rows_loaded.toLocaleString()} rows
                    </p>
                  )}
                  {run?.status === "error" && (
                    <p className="mt-1 truncate text-xs text-red-600" title={run.error_message ?? ""}>
                      {run.error_message}
                    </p>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
