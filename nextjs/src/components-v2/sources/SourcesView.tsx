"use client"

import React, { useCallback, useEffect, useState } from "react"
import { Database, Loader2, Pencil, Plus, Trash2, RefreshCw, ArrowRight } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import EmptyState from "@/components-v2/shared/EmptyState"
import SourceDialog, { type ExistingSource } from "@/components-v2/sources/SourceDialog"
import IngestRunPanel from "@/components-v2/sources/IngestRunPanel"
import { deleteIngestSource, getIngestMeta, getIngestSources, getProjects } from "@/lib/api-client"
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

interface IngestSource extends ExistingSource {
  sourceConnection?: { id: string; name: string; connectionType: string } | null
}

const DESTINATION_LABELS: Record<string, string> = {
  ducklake: "Lakehouse",
  connection: "Project warehouse",
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  sql_database: "database",
  rest_api: "REST API",
  filesystem: "files",
}

export default function SourcesView(): React.ReactElement {
  const [sources, setSources] = useState<IngestSource[]>([])
  const [projects, setProjects] = useState<Array<{ id: string; name: string; lakehouseConnectionId?: string | null }>>([])
  const [projectFilter, setProjectFilter] = useState("")
  const [metaError, setMetaError] = useState(false)
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<IngestSource | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<IngestSource | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [meta, setMeta] = useState<{
    source_connection_types: string[]
    lakehouse_configured: boolean
    file_roots: string[]
  }>({
    source_connection_types: [],
    lakehouse_configured: false,
    file_roots: [],
  })

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const rows = await getIngestSources()
      setSources(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sources")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    getProjects().then((rows) => setProjects(Array.isArray(rows) ? rows : [])).catch(() => undefined)
    getIngestMeta()
      .then((m) =>
        setMeta({
          source_connection_types: m.source_connection_types ?? [],
          lakehouse_configured: Boolean(m.lakehouse_configured),
          file_roots: m.file_roots ?? [],
        }),
      )
      .catch(() => setMetaError(true))
  }, [load])

  async function handleDelete() {
    if (!toDelete) return
    setDeleting(true)
    try {
      await deleteIngestSource(toDelete.id)
      setToDelete(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  const needsLakehouse = (source: IngestSource) =>
    source.destination === "ducklake" &&
    !projects.find((project) => project.id === source.projectId)?.lakehouseConnectionId

  const visibleSources = sources.filter((source) =>
    (!projectFilter || source.projectId === projectFilter) &&
    `${source.name} ${source.dataset} ${source.sourceConnection?.name ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())
  )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-xl border border-slate-200 bg-white py-4">
        {[
          { label: "Saved loads", count: sources.length },
          { label: "To warehouse", count: sources.filter((source) => source.destination === "connection").length },
          { label: "To lakehouse", count: sources.filter((source) => source.destination === "ducklake").length },
        ].map((item) => <div key={item.label} className="px-4 sm:px-6"><p className="text-xs text-slate-500">{item.label}</p><p className="mt-1 text-2xl font-semibold text-slate-900">{loading || error ? "—" : item.count}</p></div>)}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label="Search data loads" placeholder="Search loads, sources or schemas…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] sm:max-w-xs" />
        <select aria-label="Filter by project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm">
          <option value="">All projects</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={load} disabled={loading} aria-label="Refresh data loads"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></Button>
          <Button onClick={() => { setEditing(null); setDialogOpen(true) }}><Plus className="mr-2 h-4 w-4" /> New load</Button>
        </div>
      </div>
      {metaError && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Source capabilities could not be loaded. Reload this page to check available database and file sources.</p>}

      {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"><p>{error}</p><Button variant="outline" size="sm" onClick={load}>Retry</Button></div>}

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
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> New load
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="hidden grid-cols-[1.2fr_1fr_1.2fr_0.9fr_200px] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-500 xl:grid">
            <span>Load / project</span><span>Source</span><span>Destination</span><span>Update rule</span><span className="text-right">Actions</span>
          </div>
          {!visibleSources.length && <p className="p-10 text-center text-sm text-slate-500">{error ? "Loads are unavailable. Retry to fetch the current list." : "No loads match your filters."}</p>}
          {visibleSources.map((source) => (
            <div key={source.id} className="border-b border-slate-100 last:border-0">
              <div className="grid items-center gap-4 p-5 xl:grid-cols-[1.2fr_1fr_1.2fr_0.9fr_200px]">
                <div className="min-w-0"><p className="break-words font-medium text-slate-900">{source.name}</p><p className="mt-1 text-xs text-slate-500">{projects.find((project) => project.id === source.projectId)?.name ?? "Project unavailable"}</p></div>
                <div className="min-w-0"><p className="text-[11px] text-slate-400 xl:hidden">SOURCE</p><p className="break-words text-sm text-slate-700">{source.sourceConnection?.name ?? SOURCE_TYPE_LABELS[source.sourceType ?? "sql_database"]}</p><p className="mt-1 text-xs text-slate-500">{source.tables.length} {source.sourceType === "rest_api" ? "resources" : "tables"}</p></div>
                <div className="min-w-0"><p className="text-[11px] text-slate-400 xl:hidden">DESTINATION</p><p className="flex items-center gap-1 text-sm text-slate-700"><ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />{DESTINATION_LABELS[source.destination]}</p><p className="mt-1 break-words font-mono text-xs text-slate-500">{source.dataset}</p>{needsLakehouse(source) && <p className="mt-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800">Needs a lakehouse — edit to set one up</p>}</div>
                <div><p className="text-sm text-slate-700">{{ append: "Add rows", replace: "Replace all rows", merge: "Update matching rows" }[source.writeDisposition] ?? source.writeDisposition}</p><p className="mt-1 text-xs text-slate-500">{source.cursorField ? `Track: ${source.cursorField}` : "Read all rows"}</p></div>
                <div className="flex items-center justify-end gap-1">
                  <Button size="sm" variant="outline" aria-expanded={expanded === source.id} aria-controls={`load-${source.id}`} onClick={() => setExpanded(expanded === source.id ? null : source.id)}>{expanded === source.id ? "Close" : "Run / history"}</Button>
                  <Button size="sm" variant="ghost" aria-label={`Edit load ${source.name}`} onClick={() => { setEditing(source); setDialogOpen(true) }}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete load ${source.name}`} onClick={() => setToDelete(source)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
              {expanded === source.id && <div id={`load-${source.id}`} className="border-t border-slate-100 bg-slate-50/70 p-5"><IngestRunPanel sourceId={source.id} sourceName={source.name} writeDisposition={source.writeDisposition} /></div>}
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={!!toDelete}
        onOpenChange={(open) => { if (!open && !deleting) setToDelete(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete data load?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>“{toDelete?.name}” stops loading. Data already in {toDelete?.dataset} stays where it is.</p>
                {toDelete?.destination === "ducklake" && (
                  <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                    This is a lakehouse source. If it is the last one in its project, dbt stops
                    attaching the lake and models referencing <code>lake.*</code> will fail to
                    resolve until another lakehouse source exists.
                  </div>
                )}
                <p className="text-xs text-gray-500">
                  The incremental cursor is dropped too, so recreating this source reloads from
                  the beginning.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(event) => { event.preventDefault(); handleDelete() }}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deleting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting…</> : "Delete load"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SourceDialog
        open={dialogOpen}
        existing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={load}
        sourceConnectionTypes={meta.source_connection_types}
        lakehouseConfigured={meta.lakehouse_configured}
        fileRoots={meta.file_roots}
      />
    </div>
  )
}
