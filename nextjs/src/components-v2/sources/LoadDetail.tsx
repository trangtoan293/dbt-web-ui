"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowLeft, Clock, Loader2, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import IngestRunPanel from "@/components-v2/sources/IngestRunPanel"
import LoadScheduleCard from "@/components-v2/sources/LoadScheduleCard"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components-v2/ui/alert-dialog"
import {
  deleteIngestSource,
  getIngestDbtSources,
  getIngestRuns,
  getIngestSources,
  getProjects,
  type IngestRunRow,
  type IngestSourceRow,
} from "@/lib/api-client"
import { destinationTableName } from "@/lib/ingest-draft"

type Tab = "runs" | "tables" | "sources"

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "tables", label: "Tables" },
  { id: "sources", label: "sources.yml" },
]

function ago(iso: string | null): string {
  if (!iso) return "never"
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 90) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/**
 * One load's own page: what it did last, table by table, and what runs it next.
 *
 * It replaces an expandable row in a list, which could show a run panel but
 * could not answer the questions that come up between runs — when did this last
 * succeed, which table moved how many rows, is it even scheduled.
 */
export default function LoadDetail({ sourceId }: { sourceId: string }): React.ReactElement {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [source, setSource] = useState<IngestSourceRow | null>(null)
  const [projectName, setProjectName] = useState("")
  const [runs, setRuns] = useState<IngestRunRow[]>([])
  const [tab, setTab] = useState<Tab>("runs")
  const [snippet, setSnippet] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const [rows, projects] = await Promise.all([getIngestSources(), getProjects()])
      const found = (Array.isArray(rows) ? rows : []).find((row) => row.id === sourceId)
      if (!found) throw new Error("This load no longer exists")
      setSource(found)
      setProjectName(
        (Array.isArray(projects) ? projects : []).find(
          (project: { id: string }) => project.id === found.projectId,
        )?.name ?? "",
      )
      const history = await getIngestRuns(sourceId).catch(() => ({ items: [] }))
      setRuns(history.items ?? [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open this load")
    } finally {
      setLoading(false)
    }
  }, [sourceId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (tab === "sources" && snippet === null) {
      getIngestDbtSources(sourceId)
        .then((data) => setSnippet(data.content))
        .catch(() => setSnippet("This load has not produced a sources.yml yet."))
    }
  }, [tab, snippet, sourceId])

  const lastRun = runs[0] ?? null
  // Row counts are recorded per table on the run, so the freshest answer to
  // "how much moved" is the last run that actually moved something.
  const lastCounts = useMemo(() => {
    const withTables = runs.find((run) => run.tables && Object.keys(run.tables).length)
    return (withTables?.tables ?? {}) as Record<string, number>
  }, [runs])

  async function handleDelete() {
    setDeleting(true)
    try {
      await deleteIngestSource(sourceId)
      router.push("/data")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this load")
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    )
  }

  if (!source) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-sm text-slate-600">{error ?? "Load not found."}</p>
        <Button className="mt-4" variant="outline" asChild>
          <Link href="/data">Back to data loads</Link>
        </Button>
      </div>
    )
  }

  const statusColour =
    lastRun?.status === "success"
      ? "bg-emerald-500"
      : lastRun?.status === "running"
        ? "bg-sky-500"
        : lastRun
          ? "bg-red-500"
          : "bg-slate-300"

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <Link
          href="/data"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" /> Data loads
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">{source.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
              <span className={`inline-block h-2 w-2 rounded-full ${statusColour}`} />
              <span>
                {lastRun ? `${lastRun.status} · ${ago(lastRun.started_at)}` : "never run"}
              </span>
              <span aria-hidden>·</span>
              <span>
                {source.sourceConnection?.name ?? source.sourceType} →{" "}
                {source.destination === "ducklake" ? "lake" : "warehouse"}.{source.dataset}
              </span>
              <span aria-hidden>·</span>
              <span>
                {source.tables.length} table{source.tables.length === 1 ? "" : "s"}
              </span>
              {projectName && (
                <>
                  <span aria-hidden>·</span>
                  <span>{projectName}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href={`/data/loads/${sourceId}/edit`}>
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <nav aria-label="Load sections" className="flex gap-1 border-b border-slate-200">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === item.id
                ? "border-[#0078D4] text-[#0078D4]"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === "runs" && (
        <div className="space-y-5">
          <IngestRunPanel
            sourceId={sourceId}
            sourceName={source.name}
            writeDisposition={source.writeDisposition}
            autoStart={searchParams.get("run") === "1"}
            onFinished={load}
          />
          <LoadScheduleCard
            sourceId={sourceId}
            projectId={source.projectId}
            loadName={source.name}
          />
        </div>
      )}

      {tab === "tables" && (
        <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {source.schemaContract === "freeze"
            ? "If the source grows a column, this load stops and names it rather than absorbing the change."
            : "If the source grows a column, this load adds it to the destination."}{" "}
          <Link href={`/data/loads/${sourceId}/edit`} className="text-[#0078D4] underline">
            Change
          </Link>
        </p>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5 text-left font-medium">Source table</th>
                <th className="px-4 py-2.5 text-left font-medium">Lands as</th>
                <th className="px-4 py-2.5 text-left font-medium">Updates</th>
                <th className="px-4 py-2.5 text-left font-medium">Tracks changes on</th>
                <th className="px-4 py-2.5 text-right font-medium">Rows last run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {source.tables.map((table) => {
                const config = source.tableConfig?.[table] ?? {}
                const cursor = config.cursorField ?? source.cursorField
                const landed = destinationTableName(table)
                return (
                  <tr key={table}>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-800">{table}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{landed}</td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {config.writeDisposition ?? source.writeDisposition}
                    </td>
                    <td className="px-4 py-2.5">
                      {cursor ? (
                        <span className="font-mono text-xs text-slate-700">{cursor}</span>
                      ) : (
                        <span className="text-xs text-amber-700">
                          nothing — reads everything each run
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                      {lastCounts[landed]?.toLocaleString() ??
                        lastCounts[table]?.toLocaleString() ??
                        "—"}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </div>
      )}

      {tab === "sources" && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Written into the project at{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">
              models/sources/_{source.dataset}.yml
            </code>{" "}
            after every successful load, so models can reference these tables without anyone
            copying anything.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">
            {snippet ?? "Loading…"}
          </pre>
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={(open) => !deleting && setConfirmDelete(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this load?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  “{source.name}” stops loading. Data already in {source.dataset} stays where it
                  is.
                </p>
                <p className="text-xs text-slate-500">
                  The incremental cursor is dropped too, so recreating this load reads from the
                  beginning.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault()
                handleDelete()
              }}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete load
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <p className="flex items-center gap-1.5 text-xs text-slate-400">
        <Clock className="h-3.5 w-3.5" />
        Times are shown in your browser&apos;s timezone; schedules run in UTC.
      </p>
    </div>
  )
}
