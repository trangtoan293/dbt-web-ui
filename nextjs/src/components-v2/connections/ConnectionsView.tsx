"use client"

import React, { useState, useEffect, useCallback } from "react"
import { getConnections, deleteConnection, testConnectionById, getConnectionUsage, type ConnectionUsage } from "@/lib/api-client"
import { Card, CardContent } from "@/components-v2/ui/card"
import { Button } from "@/components-v2/ui/button"
import { AlertCircle, CheckCircle2, Loader2, Pencil, PlugZap, Server, Trash2, X } from "lucide-react"
import EmptyState from "@/components-v2/shared/EmptyState"
import ConnectionDialog, { ExistingConnection } from "@/components-v2/connections/ConnectionDialog"
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

interface Connection {
  id: string
  name: string
  connectionType: string
  host: string
  port: number
  database: string
  username: string
  passwordEncrypted?: string | null
  sslMode?: string | null
  extraConfig?: Record<string, unknown> | null
  catalog?: string | null
  _sourceTable: "connection" | "dremio_source"
}

const TYPE_LABELS: Record<string, string> = {
  postgresql: "PostgreSQL",
  duckdb: "DuckDB",
  dremio: "Dremio",
  oracle: "Oracle",
  spark: "Apache Spark",
}

export default function ConnectionsView() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [editing, setEditing] = useState<Connection | null>(null)
  const [connectionToDelete, setConnectionToDelete] = useState<Connection | null>(null)
  const [usage, setUsage] = useState<ConnectionUsage | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await getConnections()
      setConnections(Array.isArray(data) ? data : [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load connections")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Ask what depends on the connection as soon as the confirmation opens, so the
  // dialog can name the projects and ingest sources instead of warning vaguely.
  useEffect(() => {
    if (!connectionToDelete) { setUsage(null); return }
    let cancelled = false
    setUsageLoading(true)
    getConnectionUsage(connectionToDelete.id)
      .then((u) => { if (!cancelled) setUsage(u) })
      .catch(() => { if (!cancelled) setUsage(null) })
      .finally(() => { if (!cancelled) setUsageLoading(false) })
    return () => { cancelled = true }
  }, [connectionToDelete])

  async function handleDelete() {
    const c = connectionToDelete
    if (!c) return
    setDeleting(c.id)
    setFeedback(null)
    try {
      const type = c._sourceTable === "dremio_source" ? "dremio" : "connection"
      await deleteConnection(c.id, type)
      setConnections((prev) => prev.filter((x) => x.id !== c.id))
      setConnectionToDelete(null)
      setFeedback({ type: "success", message: `Connection “${c.name}” was deleted.` })
    } catch (e) {
      setFeedback({ type: "error", message: e instanceof Error ? e.message : "Delete failed" })
    } finally {
      setDeleting(null)
    }
  }

  async function handleTest(c: Connection) {
    setTesting(c.id)
    setFeedback(null)
    try {
      const type = c._sourceTable === "dremio_source" ? "dremio" : "connection"
      const result = await testConnectionById(c.id, type)
      setFeedback({
        type: result.success ? "success" : "error",
        message: result.success ? `Connection “${c.name}” is healthy.` : `Connection “${c.name}” failed: ${result.message}`,
      })
    } catch (e) {
      setFeedback({ type: "error", message: e instanceof Error ? e.message : "Test failed" })
    } finally {
      setTesting(null)
    }
  }

  function handleEdit(c: Connection) {
    setEditing(c)
  }

  function handleCreated() {
    setFeedback({ type: "success", message: "Connection created successfully." })
    load()
  }

  function handleUpdated() {
    setEditing(null)
    setFeedback({ type: "success", message: "Connection updated successfully." })
    load()
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ConnectionDialog onSaved={handleCreated} />
      </div>

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={feedback.type === "success"
            ? "flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
            : "flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"}
        >
          {feedback.type === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <p className="flex-1">{feedback.message}</p>
          <button type="button" onClick={() => setFeedback(null)} aria-label="Dismiss message" className="rounded p-0.5 opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {loadError && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1"><p className="font-medium">Unable to load connections</p><p className="mt-0.5 text-red-700">{loadError}</p></div>
          <Button variant="outline" size="sm" onClick={load}>Retry</Button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6"><div className="h-4 bg-gray-200 rounded w-1/3" /></CardContent>
            </Card>
          ))}
        </div>
      ) : !loadError && connections.length === 0 ? (
        <EmptyState
          icon={PlugZap}
          title="No connections configured"
          description="Add a database connection to start running dbt models."
          action={<ConnectionDialog onSaved={load} />}
        />
      ) : !loadError ? (
        <div className="grid gap-4">
          {connections.map((c) => (
            <Card key={c.id} className="transition-[border-color,box-shadow] hover:border-slate-300 hover:shadow-md">
              <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 ring-1 ring-inset ring-blue-100">
                  <Server className="h-5 w-5 text-[#0078D4]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-gray-950">{c.name}</p>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{TYPE_LABELS[c.connectionType] ?? c.connectionType}</span>
                  </div>
                  <p className="mt-1 truncate text-sm text-gray-500">{c.host || c.database || "Local connection"}{c.port ? `:${c.port}` : ""}</p>
                </div>
                <div className="flex items-center gap-2 sm:shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(c)}
                    disabled={testing === c.id}
                    title="Test connection"
                  >
                    {testing === c.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZap className="h-4 w-4" />
                    )}
                    <span className="ml-1 hidden sm:inline">Test</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(c)}
                    title="Edit connection"
                  >
                    <Pencil className="h-4 w-4" />
                    <span className="ml-1 hidden sm:inline">Edit</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConnectionToDelete(c)}
                    disabled={deleting === c.id}
                    className="text-red-600 hover:text-red-700 hover:border-red-300"
                    title="Delete connection"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {editing && (
        <ConnectionDialog
          existing={editing as ExistingConnection}
          onClose={() => setEditing(null)}
          onSaved={handleUpdated}
        />
      )}

      <AlertDialog open={!!connectionToDelete} onOpenChange={(open) => { if (!open && !deleting) setConnectionToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete connection?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>“{connectionToDelete?.name}” will be removed from this workspace.</p>
                {usageLoading && <p className="text-xs">Checking what still uses it…</p>}
                {usage?.blocked && (
                  <div className="rounded-md bg-red-50 p-2 text-xs text-red-700">
                    <p className="font-medium">
                      Cannot delete: {usage.ingest_source_count} ingest source(s) read from it.
                    </p>
                    <ul className="mt-1 list-inside list-disc">
                      {usage.ingest_sources.map((s) => (
                        <li key={s.id}>{s.name} — {s.project_name} → {s.dataset}</li>
                      ))}
                    </ul>
                    <p className="mt-1">Delete those sources first, on the Sources page.</p>
                  </div>
                )}
                {!usage?.blocked && usage?.project_count ? (
                  <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                    <p className="font-medium">
                      {usage.project_count} project(s) run dbt through this connection and will
                      stop working:
                    </p>
                    <ul className="mt-1 list-inside list-disc">
                      {usage.projects.map((p) => <li key={p.id}>{p.name}</li>)}
                    </ul>
                  </div>
                ) : null}
                {usage && !usage.in_use && (
                  <p className="text-xs text-gray-500">Nothing currently uses this connection.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!deleting || usageLoading || Boolean(usage?.blocked)}
              onClick={(event) => { event.preventDefault(); handleDelete() }}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              {deleting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting...</> : "Delete connection"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
