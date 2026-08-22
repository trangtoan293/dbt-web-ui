"use client"

import React, { useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components-v2/ui/dialog"
import { Input } from "@/components-v2/ui/input"
import {
  createIngestSource,
  getConnections,
  getIngestConnectionTables,
  getProjects,
  updateIngestSource,
} from "@/lib/api-client"

export interface ExistingSource {
  id: string
  projectId: string
  sourceConnectionId: string
  name: string
  dataset: string
  tables: string[]
  destination: "connection" | "ducklake"
  writeDisposition: string
  primaryKey?: string[] | null
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  existing?: ExistingSource | null
  /** Connection types dbt-runner can read from, from /ingest/meta. */
  sourceConnectionTypes: string[]
  lakehouseConfigured: boolean
}

const DATASET_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

const DISPOSITION_HELP: Record<string, string> = {
  append: "Adds rows on every run. Safest default; duplicates if the source has no cursor.",
  replace: "Drops and rewrites the target tables each run.",
  merge: "Upserts on the primary key. Requires a primary key.",
}

export default function SourceDialog({
  open,
  onClose,
  onSaved,
  existing,
  sourceConnectionTypes,
  lakehouseConfigured,
}: Props): React.ReactElement {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [connections, setConnections] = useState<Array<{ id: string; name: string; connectionType: string }>>([])
  const [projectId, setProjectId] = useState("")
  const [connectionId, setConnectionId] = useState("")
  const [name, setName] = useState("")
  const [dataset, setDataset] = useState("")
  const [tables, setTables] = useState<string[]>([])
  const [tableInput, setTableInput] = useState("")
  const [availableTables, setAvailableTables] = useState<string[] | null>(null)
  const [loadingTables, setLoadingTables] = useState(false)
  const [destination, setDestination] = useState<"connection" | "ducklake">("ducklake")
  const [writeDisposition, setWriteDisposition] = useState("append")
  const [primaryKey, setPrimaryKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    Promise.all([getProjects(), getConnections()])
      .then(([p, c]) => {
        setProjects(Array.isArray(p) ? p : [])
        setConnections(
          (Array.isArray(c) ? c : []).filter(
            (row: { connectionType: string; _sourceTable?: string }) =>
              row._sourceTable === "connection" && sourceConnectionTypes.includes(row.connectionType),
          ),
        )
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load form data"))
  }, [open, sourceConnectionTypes])

  useEffect(() => {
    if (!open) return
    setProjectId(existing?.projectId ?? "")
    setConnectionId(existing?.sourceConnectionId ?? "")
    setName(existing?.name ?? "")
    setDataset(existing?.dataset ?? "")
    setTables(existing?.tables ?? [])
    setDestination(existing?.destination ?? "ducklake")
    setWriteDisposition(existing?.writeDisposition ?? "append")
    setPrimaryKey((existing?.primaryKey ?? []).join(", "))
    setAvailableTables(null)
    setTableInput("")
  }, [open, existing])

  // Reads the chosen connection directly, so browsing works before the source
  // has ever been saved.
  async function loadTables() {
    if (!connectionId) {
      setError("Choose a connection first")
      return
    }
    setError(null)
    setLoadingTables(true)
    try {
      const result = await getIngestConnectionTables(connectionId)
      if (result.success) setAvailableTables(result.tables)
      else setError(result.message ?? "Could not read tables from the connection")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read tables")
    } finally {
      setLoadingTables(false)
    }
  }

  const datasetValid = useMemo(() => DATASET_PATTERN.test(dataset), [dataset])

  function addTable(value: string) {
    const trimmed = value.trim()
    if (trimmed && !tables.includes(trimmed)) setTables([...tables, trimmed])
    setTableInput("")
  }

  async function handleSave() {
    setError(null)
    if (!projectId) return setError("Choose a project")
    if (!connectionId) return setError("Choose a source connection")
    if (!datasetValid) {
      return setError(
        "Dataset must start with a letter and use only lowercase letters, digits and underscores",
      )
    }
    if (tables.length === 0) return setError("Add at least one table")
    if (writeDisposition === "merge" && !primaryKey.trim()) {
      return setError("Merge needs a primary key")
    }

    const payload = {
      projectId,
      sourceConnectionId: connectionId,
      name,
      dataset,
      tables,
      destination,
      writeDisposition,
      primaryKey: primaryKey
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    }

    setSaving(true)
    try {
      if (existing) await updateIngestSource(existing.id, payload)
      else await createIngestSource(payload)
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit source" : "New source"}</DialogTitle>
          <DialogDescription>
            Choose a connection to read from, the tables to load, and where they land.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Project</span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={Boolean(existing)}
              >
                <option value="">Select…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Read from connection</span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={connectionId}
                onChange={(e) => {
                  setConnectionId(e.target.value)
                  setAvailableTables(null)
                }}
              >
                <option value="">Select…</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.connectionType})</option>
                ))}
              </select>
              {connections.length === 0 ? (
                <span className="mt-1 block text-xs text-amber-700">
                  No connection here can be read from yet. Ingest reads over SQL, so it
                  needs a {sourceConnectionTypes.join(" or ")} connection — create one on
                  the Connections page first.
                </span>
              ) : (
                <span className="mt-1 block text-xs text-gray-500">
                  Only {sourceConnectionTypes.join(", ")} connections can be read from.
                </span>
              )}
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM customers" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Dataset (target schema)</span>
              <Input value={dataset} onChange={(e) => setDataset(e.target.value.toLowerCase())} placeholder="raw_crm" />
              {dataset && !datasetValid && (
                <span className="mt-1 block text-xs text-red-600">
                  Lowercase letters, digits and underscores only; must start with a letter.
                </span>
              )}
            </label>
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium text-gray-700">Tables</span>
            <div className="flex gap-2">
              <Input
                value={tableInput}
                onChange={(e) => setTableInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addTable(tableInput)
                  }
                }}
                placeholder="customers"
              />
              <Button type="button" variant="outline" onClick={() => addTable(tableInput)}>Add</Button>
              <Button
                type="button"
                variant="outline"
                onClick={loadTables}
                disabled={loadingTables || !connectionId}
                title={connectionId ? "List tables on the connection" : "Choose a connection first"}
              >
                {loadingTables ? <Loader2 className="h-4 w-4 animate-spin" /> : "Browse"}
              </Button>
            </div>
            {availableTables && (
              <div className="mt-2 max-h-32 overflow-y-auto rounded-md border border-gray-200 p-2">
                {availableTables.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="mr-1 mb-1 rounded bg-gray-100 px-2 py-1 text-xs hover:bg-gray-200"
                    onClick={() => addTable(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {tables.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">
                  {t}
                  <button type="button" onClick={() => setTables(tables.filter((x) => x !== t))}>×</button>
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Write to</span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={destination}
                onChange={(e) => setDestination(e.target.value as "connection" | "ducklake")}
              >
                <option value="ducklake" disabled={!lakehouseConfigured}>
                  Lakehouse (DuckLake){lakehouseConfigured ? "" : " — not configured"}
                </option>
                <option value="connection">The project&apos;s own warehouse</option>
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Write disposition</span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={writeDisposition}
                onChange={(e) => setWriteDisposition(e.target.value)}
              >
                {Object.keys(DISPOSITION_HELP).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-gray-500">{DISPOSITION_HELP[writeDisposition]}</span>
            </label>
          </div>

          {writeDisposition === "merge" && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Primary key</span>
              <Input value={primaryKey} onChange={(e) => setPrimaryKey(e.target.value)} placeholder="id" />
              <span className="mt-1 block text-xs text-gray-500">Comma-separated for a composite key.</span>
            </label>
          )}

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {existing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
