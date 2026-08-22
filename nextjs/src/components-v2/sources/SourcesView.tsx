"use client"

import React, { useCallback, useEffect, useState } from "react"
import { ChevronRight, Database, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Card, CardContent } from "@/components-v2/ui/card"
import EmptyState from "@/components-v2/shared/EmptyState"
import SourceDialog, { type ExistingSource } from "@/components-v2/sources/SourceDialog"
import IngestRunPanel from "@/components-v2/sources/IngestRunPanel"
import { deleteIngestSource, getIngestMeta, getIngestSources } from "@/lib/api-client"
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

export default function SourcesView(): React.ReactElement {
  const [sources, setSources] = useState<IngestSource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<IngestSource | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<IngestSource | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [meta, setMeta] = useState<{ source_connection_types: string[]; lakehouse_configured: boolean }>({
    source_connection_types: [],
    lakehouse_configured: false,
  })

  const load = useCallback(async () => {
    setError(null)
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
    getIngestMeta()
      .then((m) =>
        setMeta({
          source_connection_types: m.source_connection_types ?? [],
          lakehouse_configured: Boolean(m.lakehouse_configured),
        }),
      )
      .catch(() => undefined)
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> New source
        </Button>
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No sources yet"
          description="A source reads tables from one of your connections and loads them where dbt can model them."
          action={
            <Button
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="mr-2 h-4 w-4" /> New source
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {sources.map((source) => (
            <Card key={source.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <button
                    className="flex min-w-0 items-start gap-2 text-left"
                    aria-expanded={expanded === source.id}
                    onClick={() => setExpanded(expanded === source.id ? null : source.id)}
                  >
                    <ChevronRight
                      className={`mt-0.5 h-4 w-4 shrink-0 text-gray-400 transition-transform ${
                        expanded === source.id ? "rotate-90" : ""
                      }`}
                    />
                    <span className="min-w-0">
                    <p className="font-medium text-gray-900">{source.name}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {source.sourceConnection?.name ?? "connection"} → {DESTINATION_LABELS[source.destination]} ·{" "}
                      {source.dataset} · {source.tables.length} table(s) · {source.writeDisposition}
                    </p>
                    </span>
                  </button>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(source)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setToDelete(source)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {expanded === source.id && (
                  <IngestRunPanel
                    sourceId={source.id}
                    sourceName={source.name}
                    writeDisposition={source.writeDisposition}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog
        open={!!toDelete}
        onOpenChange={(open) => { if (!open && !deleting) setToDelete(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete source?</AlertDialogTitle>
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
              {deleting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting…</> : "Delete source"}
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
      />
    </div>
  )
}
