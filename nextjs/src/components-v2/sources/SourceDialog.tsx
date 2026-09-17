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
import FileSourceFields, { type FileSourceConfig } from "./FileSourceFields"
import RestSourceFields, { type RestSourceConfig } from "./RestSourceFields"

type SourceType = "sql_database" | "rest_api" | "filesystem"

const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  sql_database: "Database tables",
  rest_api: "REST API",
  filesystem: "Files on disk",
}

const SOURCE_TYPE_HELP: Record<SourceType, string> = {
  sql_database:
    "Reads tables over SQL from a connection. Needs a PostgreSQL, Oracle or MySQL connection.",
  rest_api:
    "Reads endpoints from a REST API. A `rest` connection carries the credential; a public API needs none.",
  filesystem:
    "Reads CSV, JSONL or Parquet from a directory the server is configured to allow. No connection.",
}

/** Which connection type each source kind reads through, if any. */
const CONNECTION_TYPE_FOR_SOURCE: Record<SourceType, string[] | null> = {
  sql_database: null, // whatever /ingest/meta reports
  rest_api: ["rest"],
  filesystem: null,
}

export interface ExistingSource {
  id: string
  projectId: string
  sourceConnectionId: string | null
  sourceType?: SourceType
  name: string
  dataset: string
  tables: string[]
  sourceConfig?: Record<string, unknown> | null
  cursorField?: string | null
  cursorInitialValue?: string | null
  destination: "connection" | "ducklake"
  writeDisposition: string
  primaryKey?: string[] | null
  partitionBy?: string[] | null
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
  existing?: ExistingSource | null
  /** Connection types dbt-runner can read from, from /ingest/meta. */
  sourceConnectionTypes: string[]
  lakehouseConfigured: boolean
  /** From /ingest/meta: whether INGEST_FILE_ROOTS is set server-side. */
  fileRootsConfigured?: boolean
}

const DATASET_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
// Mirrors PARTITION_TERM_PATTERN in lib/actions/data.ts, which mirrors the
// enforcing regex in dbt-runner/ingest/lakehouse.py.
const PARTITION_TERM_PATTERN =
  /^(?:(?:year|month|day|hour)\([A-Za-z_][A-Za-z0-9_$]{0,62}\)|[A-Za-z_][A-Za-z0-9_$]{0,62})$/i

// Mirrors _CURSOR_RE in dbt-runner/app/routers/ingest.py, the enforcing side.
const CURSOR_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

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
  fileRootsConfigured = false,
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
  const [sourceType, setSourceType] = useState<SourceType>("sql_database")
  const [sourceConfig, setSourceConfig] = useState<Record<string, unknown>>({})
  const [cursorField, setCursorField] = useState("")
  const [cursorInitialValue, setCursorInitialValue] = useState("")
  const [destination, setDestination] = useState<"connection" | "ducklake">("ducklake")
  const [writeDisposition, setWriteDisposition] = useState("append")
  const [primaryKey, setPrimaryKey] = useState("")
  const [partitionBy, setPartitionBy] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allowedConnectionTypes = useMemo(
    () => CONNECTION_TYPE_FOR_SOURCE[sourceType] ?? sourceConnectionTypes,
    [sourceType, sourceConnectionTypes],
  )

  useEffect(() => {
    if (!open) return
    setError(null)
    Promise.all([getProjects(), getConnections()])
      .then(([p, c]) => {
        setProjects(Array.isArray(p) ? p : [])
        setConnections(
          (Array.isArray(c) ? c : []).filter(
            (row: { connectionType: string; _sourceTable?: string }) =>
              row._sourceTable === "connection" &&
              allowedConnectionTypes.includes(row.connectionType),
          ),
        )
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load form data"))
  }, [open, allowedConnectionTypes])

  useEffect(() => {
    if (!open) return
    setProjectId(existing?.projectId ?? "")
    setConnectionId(existing?.sourceConnectionId ?? "")
    setName(existing?.name ?? "")
    setDataset(existing?.dataset ?? "")
    setTables(existing?.tables ?? [])
    setSourceType(existing?.sourceType ?? "sql_database")
    setSourceConfig((existing?.sourceConfig ?? {}) as Record<string, unknown>)
    setCursorField(existing?.cursorField ?? "")
    setCursorInitialValue(existing?.cursorInitialValue ?? "")
    setDestination(existing?.destination ?? "ducklake")
    setWriteDisposition(existing?.writeDisposition ?? "append")
    setPrimaryKey((existing?.primaryKey ?? []).join(", "))
    setPartitionBy((existing?.partitionBy ?? []).join(", "))
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

  /** The chosen type's own fields only - a stale glob must not reach a REST source. */
  function normalisedSourceConfig(): Record<string, unknown> {
    if (sourceType === "filesystem") {
      const config = sourceConfig as FileSourceConfig
      return {
        bucket_url: config.bucket_url ?? "",
        file_glob: config.file_glob || "*",
        format: config.format ?? "csv",
      }
    }
    const config = sourceConfig as RestSourceConfig
    return {
      base_url: config.base_url ?? "",
      paginator: config.paginator ?? { type: "auto" },
      resources: (config.resources ?? [])
        .filter((r) => tables.includes(r.name))
        .map((r) => ({
          name: r.name,
          path: r.path || r.name,
          ...(r.data_selector ? { data_selector: r.data_selector } : {}),
          ...(r.params && Object.keys(r.params).length ? { params: r.params } : {}),
          // Dropped with the cursor: the server refuses a cursor parameter that
          // has no cursor field to send, and it would be dead config anyway.
          ...(cursorField.trim() && r.incremental_param
            ? { incremental_param: r.incremental_param }
            : {}),
        })),
    }
  }

  function addTable(value: string) {
    const trimmed = value.trim()
    if (trimmed && !tables.includes(trimmed)) setTables([...tables, trimmed])
    setTableInput("")
  }

  async function handleSave() {
    setError(null)
    if (!projectId) return setError("Choose a project")
    if (sourceType === "sql_database" && !connectionId) {
      return setError("A database source needs a connection to read from")
    }
    if (!datasetValid) {
      return setError(
        "Dataset must start with a letter and use only lowercase letters, digits and underscores",
      )
    }
    if (tables.length === 0) return setError("Add at least one table")
    if (writeDisposition === "merge" && !primaryKey.trim()) {
      return setError("Merge needs a primary key")
    }
    if (cursorField.trim() && !CURSOR_PATTERN.test(cursorField.trim())) {
      return setError(`Invalid cursor field "${cursorField.trim()}": it must be a column name`)
    }
    if (sourceType === "filesystem") {
      if (tables.length !== 1) {
        return setError("A filesystem source loads one directory into one table")
      }
      if (!String((sourceConfig as FileSourceConfig).bucket_url ?? "").trim()) {
        return setError("Choose a directory to read from")
      }
    }
    if (sourceType === "rest_api") {
      const resources = ((sourceConfig as RestSourceConfig).resources ?? []).filter((r) =>
        tables.includes(r.name),
      )
      const missing = tables.filter((t) => !resources.some((r) => r.name === t))
      if (missing.length) {
        return setError(`Give an endpoint path for: ${missing.slice(0, 5).join(", ")}`)
      }
      if (!String((sourceConfig as RestSourceConfig).base_url ?? "").trim() && !connectionId) {
        return setError("A REST source needs a base URL, or a connection that carries one")
      }
    }
    const partitionTerms = partitionBy
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
    const badTerm = partitionTerms.find((t) => !PARTITION_TERM_PATTERN.test(t))
    if (badTerm) {
      return setError(`Invalid partition term "${badTerm}": use a column, or year/month/day/hour(column)`)
    }

    const payload = {
      projectId,
      // A filesystem source has no connection; a public API may have none.
      sourceConnectionId: sourceType === "filesystem" ? null : connectionId || null,
      sourceType,
      name,
      dataset,
      tables,
      // Only the chosen type's own configuration is sent, so switching type does
      // not carry the previous one's fields along.
      sourceConfig: sourceType === "sql_database" ? null : normalisedSourceConfig(),
      cursorField: cursorField.trim() || null,
      cursorInitialValue: cursorInitialValue.trim() || null,
      destination,
      writeDisposition,
      primaryKey: primaryKey
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      // Only the lake has a Parquet layout to partition; the server rejects the
      // combination, so do not send it.
      partitionBy: destination === "ducklake" ? partitionTerms : [],
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
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Read from</span>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={sourceType}
              onChange={(e) => {
                setSourceType(e.target.value as SourceType)
                // Each type reads through a different connection type (or none),
                // so a carried-over id would point at something unreadable.
                setConnectionId("")
                setSourceConfig({})
                setAvailableTables(null)
              }}
              disabled={Boolean(existing)}
            >
              {(Object.keys(SOURCE_TYPE_LABELS) as SourceType[]).map((t) => (
                <option key={t} value={t}>{SOURCE_TYPE_LABELS[t]}</option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-gray-500">{SOURCE_TYPE_HELP[sourceType]}</span>
          </label>

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

            {sourceType === "filesystem" ? (
              <div className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">Connection</span>
                <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  Not used. A filesystem source reads a path, so it stores no
                  credential and references no connection.
                </p>
              </div>
            ) : (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">
                {sourceType === "rest_api" ? "Credential (optional)" : "Read from connection"}
              </span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={connectionId}
                onChange={(e) => {
                  setConnectionId(e.target.value)
                  setAvailableTables(null)
                }}
              >
                <option value="">
                  {sourceType === "rest_api" ? "None — public API" : "Select…"}
                </option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.connectionType})</option>
                ))}
              </select>
              {connections.length === 0 ? (
                <span className="mt-1 block text-xs text-amber-700">
                  No {allowedConnectionTypes.join(" or ")} connection exists yet — create
                  one on the Connections page.
                </span>
              ) : (
                <span className="mt-1 block text-xs text-gray-500">
                  Only {allowedConnectionTypes.join(", ")} connections can be used here.
                </span>
              )}
            </label>
            )}
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
              {sourceType === "sql_database" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={loadTables}
                  disabled={loadingTables || !connectionId}
                  title={connectionId ? "List tables on the connection" : "Choose a connection first"}
                >
                  {loadingTables ? <Loader2 className="h-4 w-4 animate-spin" /> : "Browse"}
                </Button>
              )}
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

          {sourceType === "filesystem" && (
            <FileSourceFields
              config={sourceConfig as FileSourceConfig}
              onChange={(next) => setSourceConfig(next as Record<string, unknown>)}
              rootsConfigured={fileRootsConfigured}
            />
          )}

          {sourceType === "rest_api" && (
            <RestSourceFields
              tables={tables}
              config={sourceConfig as RestSourceConfig}
              onChange={(next) => setSourceConfig(next as Record<string, unknown>)}
              hasCursor={Boolean(cursorField.trim())}
              baseUrlFromConnection={Boolean(connectionId)}
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Cursor field</span>
              <Input
                value={cursorField}
                onChange={(e) => setCursorField(e.target.value)}
                placeholder={sourceType === "filesystem" ? "modification_date" : "updated_at"}
              />
              <span className="mt-1 block text-xs text-gray-500">
                Optional, and the single biggest thing on this form. Without it every
                run reads the whole source: append then duplicates it, and merge only
                removes the duplicates after reading everything.
              </span>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Start from</span>
              <Input
                value={cursorInitialValue}
                onChange={(e) => setCursorInitialValue(e.target.value)}
                placeholder="2026-01-01"
                disabled={!cursorField.trim()}
              />
              <span className="mt-1 block text-xs text-gray-500">
                Lower bound for the first run, so it need not read all history.
              </span>
            </label>
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

          {destination === "ducklake" && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Partition by</span>
              <Input
                value={partitionBy}
                onChange={(e) => setPartitionBy(e.target.value)}
                placeholder="month(created_at)"
              />
              <span className="mt-1 block text-xs text-gray-500">
                Optional, but at scale it is the difference between reading one month of
                Parquet and reading the whole table. A column name, or
                year/month/day/hour(column); comma-separated for several. Applies to every
                table this source writes, and to writes made after it is set.
              </span>
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
