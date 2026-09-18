"use client"

import Link from "next/link"
import React, { useCallback, useEffect, useMemo, useState } from "react"
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
  createConnection,
  createIngestSource,
  getConnections,
  getIngestConnectionTables,
  getProjects,
  setProjectLakehouse,
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
    "Copy API resources into tables. Public APIs need only a base URL; private APIs use saved credentials.",
  filesystem:
    "Copy CSV, JSONL or Parquet files from an allowed server directory into a table.",
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
  /** From /ingest/meta: the server directories a filesystem source may read. */
  fileRoots?: string[]
}

const DATASET_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
// Mirrors PARTITION_TERM_PATTERN in lib/actions/data.ts, which mirrors the
// enforcing regex in dbt-runner/ingest/lakehouse.py.
const PARTITION_TERM_PATTERN =
  /^(?:(?:year|month|day|hour)\([A-Za-z_][A-Za-z0-9_$]{0,62}\)|[A-Za-z_][A-Za-z0-9_$]{0,62})$/i

// Mirrors _CURSOR_RE / _JSON_CURSOR_RE in dbt-runner/app/routers/ingest.py, the
// enforcing side. A REST cursor is a path into the JSON response, so dots are
// ordinary there and are not a column name anywhere else.
const CURSOR_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const JSON_CURSOR_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}(\.[A-Za-z_][A-Za-z0-9_$]{0,62}){0,9}$/

const DESTINATION_HELP: Record<string, string> = {
  ducklake:
    "Parquet files on shared storage, with a catalog (DuckLake) that dbt and other engines read. The usual home for raw loads.",
  connection:
    "The database this project runs dbt on. Only DuckDB and PostgreSQL warehouses can be loaded into directly.",
}

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
  fileRoots = [],
}: Props): React.ReactElement {
  const [step, setStep] = useState(0)
  const [projects, setProjects] = useState<Array<{ id: string; name: string; lakehouseConnectionId?: string | null }>>([])
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
  const [creatingLake, setCreatingLake] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allowedConnectionTypes = useMemo(
    () => CONNECTION_TYPE_FOR_SOURCE[sourceType] ?? sourceConnectionTypes,
    [sourceType, sourceConnectionTypes],
  )

  const loadFormData = useCallback(async () => {
    const [p, c] = await Promise.all([getProjects(), getConnections()])
    setProjects(Array.isArray(p) ? p : [])
    setConnections(
      (Array.isArray(c) ? c : []).filter(
        (row: { connectionType: string; _sourceTable?: string }) =>
          row._sourceTable === "connection" &&
          allowedConnectionTypes.includes(row.connectionType),
      ),
    )
  }, [allowedConnectionTypes])

  useEffect(() => {
    if (!open) return
    setError(null)
    loadFormData().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load form data"),
    )
  }, [open, loadFormData])

  useEffect(() => {
    if (!open) return
    setStep(0)
    setProjectId(existing?.projectId ?? "")
    setConnectionId(existing?.sourceConnectionId ?? "")
    setName(existing?.name ?? "")
    setDataset(existing?.dataset ?? "")
    setTables(existing?.tables ?? [])
    setSourceType(existing?.sourceType ?? "sql_database")
    setSourceConfig((existing?.sourceConfig ?? {}) as Record<string, unknown>)
    setCursorField(existing?.cursorField ?? "")
    setCursorInitialValue(existing?.cursorInitialValue ?? "")
    setDestination(existing?.destination ?? (lakehouseConfigured ? "ducklake" : "connection"))
    setWriteDisposition(existing?.writeDisposition ?? "append")
    setPrimaryKey((existing?.primaryKey ?? []).join(", "))
    setPartitionBy((existing?.partitionBy ?? []).join(", "))
    setAvailableTables(null)
    setTableInput("")
  }, [open, existing, lakehouseConfigured])

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

  // Whether *this project* can receive a lakehouse load. `lakehouseConfigured`
  // only says the deployment has a catalog URL, which is true almost always -
  // relying on it let a load be saved against a project with no lake attached
  // and fail with a 400 on the first run, after the whole wizard.
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId],
  )
  // Keyed on the resolved project, not the raw id: `projects` arrives a tick
  // after `projectId` when editing, and an id with no row yet is not a project
  // with no lake.
  const lakeBlocked = Boolean(selectedProject) && !selectedProject?.lakehouseConnectionId
  const lakeUnavailable = destination === "ducklake" && lakeBlocked

  /**
   * Create a lakehouse for this project and attach it, without leaving the form.
   *
   * A **managed** lake needs nothing from the user: dbt-runner derives the
   * catalog schema and the data directory from the connection id it is given,
   * so the only real input is a name. Asking someone to leave a half-filled
   * wizard, find Connections, pick "Lakehouse" out of eight connection types,
   * choose a mode, come back through Project Settings and attach it is the
   * whole feature's cliff - and every one of those steps had one right answer.
   */
  async function createLakehouseForProject() {
    if (!selectedProject) return
    setCreatingLake(true)
    setError(null)
    try {
      const lake = await createConnection({
        connectionType: "ducklake",
        name: `${selectedProject.name} lakehouse`,
        // A managed lake is located by dbt-runner; these stay empty on purpose.
        host: "",
        port: 0,
        database: "",
        username: "",
        extraConfig: { mode: "managed" },
      })
      await setProjectLakehouse(selectedProject.id, { connectionId: lake.id })
      await loadFormData()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the lakehouse")
    } finally {
      setCreatingLake(false)
    }
  }

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
    const byName = new Map((config.resources ?? []).map((r) => [r.name, r]))
    return {
      // Trimmed: a pasted URL often carries a leading space, and the stored
      // value is what the form shows back.
      base_url: (config.base_url ?? "").trim(),
      paginator: config.paginator ?? { type: "auto" },
      // Driven by the table list so every table gets an endpoint, defaulting to
      // its own name. Deriving it from `resources` instead dropped any table the
      // user never typed a field for.
      resources: tables
        .map((table) => byName.get(table) ?? { name: table })
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

  function nextStep() {
    setError(null)
    if (step === 0) {
      if (sourceType === "sql_database" && !connectionId) return setError("Choose a source connection")
      if (!tables.length) return setError("Select at least one table or resource")
      if (sourceType === "filesystem") {
        if (!fileRoots.length) return setError("File access is not configured for this workspace")
        if (tables.length !== 1) return setError("File loads write to one destination table")
        if (!String(sourceConfig.bucket_url ?? "").trim()) return setError("Choose a directory to read from")
      }
      if (sourceType === "rest_api") {
        if (!String(sourceConfig.base_url ?? "").trim() && !connectionId) return setError("Enter an API base URL or choose a connection")
        // No per-resource check: an endpoint path defaults to the resource name,
        // so there is nothing left for the user to supply.
        if (String((sourceConfig as RestSourceConfig).paginator?.type ?? "auto") === "offset" && !String((sourceConfig as RestSourceConfig).paginator?.limit ?? "").trim()) return setError("The offset paginator needs a records-per-page value")
      }
    }
    if (step === 1) {
      if (!projectId) return setError("Choose a project")
      if (!name.trim()) return setError("Give this load a name")
      if (!datasetValid) return setError("Schema must start with a lowercase letter and contain only lowercase letters, digits and underscores")
      if (destination === "ducklake" && !lakehouseConfigured) return setError("Choose an available destination")
      if (lakeUnavailable) return setError("This project has no lakehouse attached. Attach one, or load into the project's own warehouse.")
    }
    setStep(step + 1)
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
    if (lakeUnavailable) {
      return setError("This project has no lakehouse attached. Attach one, or load into the project's own warehouse.")
    }
    if (writeDisposition === "merge" && !primaryKey.trim()) {
      return setError("Merge needs a primary key")
    }
    const cursorPattern = sourceType === "rest_api" ? JSON_CURSOR_PATTERN : CURSOR_PATTERN
    if (cursorField.trim() && !cursorPattern.test(cursorField.trim())) {
      return setError(
        sourceType === "rest_api"
          ? `Invalid cursor "${cursorField.trim()}": use field names separated by dots`
          : `Invalid cursor field "${cursorField.trim()}": it must be a column name`,
      )
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
      if (!String((sourceConfig as RestSourceConfig).base_url ?? "").trim() && !connectionId) {
        return setError("A REST source needs a base URL, or a connection that carries one")
      }
      const paginator = (sourceConfig as RestSourceConfig).paginator
      if (String(paginator?.type ?? "auto") === "offset" && !String(paginator?.limit ?? "").trim()) {
        return setError("The offset paginator needs a records-per-page value")
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
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit data load" : "New data load"}</DialogTitle>
          <DialogDescription>
            {["Select the source and the data you want to copy.", "Choose the project and schema that will receive this data.", "Decide how each run updates the destination."][step]}
          </DialogDescription>
        </DialogHeader>


        <ol aria-label="Load setup steps" className="grid shrink-0 grid-cols-3 gap-2 border-b border-slate-200 pb-4">
          {["Choose data", "Destination", "Update rules"].map((label, index) => (
            <li key={label} aria-current={step === index ? "step" : undefined} className={`rounded-lg px-3 py-2 text-sm ${step === index ? "bg-blue-50 font-semibold text-[#0078D4]" : "text-slate-500"}`}>{index + 1}. {label}</li>
          ))}
        </ol>
        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          {step === 0 && <div className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Source type</span>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={sourceType}
              onChange={(e) => {
                setSourceType(e.target.value as SourceType)
                // Each type reads through a different connection type (or none),
                // so a carried-over id would point at something unreadable.
                setTables([])
                setTableInput("")
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


            {sourceType === "filesystem" ? (
              <div className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">Connection</span>
                <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  File loads use a server directory. No database connection is needed.
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
                  setTables([])
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
              {connections.length === 0 && sourceType === "rest_api" ? (
                <span className="mt-1 block text-xs text-gray-500">For a public API, leave this empty and enter the base URL below.</span>
              ) : connections.length === 0 ? (
                <span className="mt-1 block text-xs text-amber-700">
                  No compatible connection found. <Link href="/data?tab=connections" className="underline">Add a connection</Link> to read database tables.
                </span>
              ) : (
                <span className="mt-1 block text-xs text-gray-500">
                  Only {allowedConnectionTypes.join(", ")} connections can be used here.
                </span>
              )}
            </label>
            )}
          <div>
            <span className="mb-1 block text-sm font-medium text-gray-700">{sourceType === "rest_api" ? "API resources" : sourceType === "filesystem" ? "Destination table name" : "Source tables"}</span>
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
              roots={fileRoots}
            />
          )}

          {sourceType === "rest_api" && (
            <RestSourceFields
              tables={tables}
              config={sourceConfig as RestSourceConfig}
              onChange={(next) => setSourceConfig(next as Record<string, unknown>)}
              baseUrlFromConnection={Boolean(connectionId)}
              connectionId={connectionId}
            />
          )}


          </div>}
          {step === 1 && <div className="space-y-4">
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


            {projects.length === 0 && <p className="text-sm text-slate-600">A load belongs to a dbt project. <Link href="/develop/new" className="text-[#0078D4] underline">Create a project</Link> before continuing.</p>}
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Destination</span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={destination}
                onChange={(e) => setDestination(e.target.value as "connection" | "ducklake")}
              >
                <option value="ducklake" disabled={!lakehouseConfigured}>
                  Lakehouse{lakehouseConfigured ? "" : " — not available on this server"}
                </option>
                <option value="connection">The project&apos;s own warehouse</option>
              </select>
              <span className="mt-1 block text-xs text-gray-500">
                {!projectId
                  ? "Choose a project first — each project has its own lakehouse."
                  : DESTINATION_HELP[destination]}
              </span>
            </label>

            {lakeUnavailable && (
              <div role="alert" className="space-y-2 rounded-md bg-amber-50 px-3 py-3 text-sm text-amber-900">
                <p>
                  “{selectedProject?.name}” doesn&apos;t have a lakehouse yet. Set one up and this
                  load can write to it — storage and catalog are created for you.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={createLakehouseForProject} disabled={creatingLake}>
                    {creatingLake ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Set up a lakehouse
                  </Button>
                  <button
                    type="button"
                    className="text-xs font-medium underline"
                    onClick={() => setDestination("connection")}
                    disabled={creatingLake}
                  >
                    or load into the project&apos;s own warehouse
                  </button>
                </div>
              </div>
            )}


          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Load name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM customers" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Destination schema</span>
              <Input value={dataset} onChange={(e) => setDataset(e.target.value.toLowerCase())} placeholder="raw_crm" />
              {dataset && !datasetValid && (
                <span className="mt-1 block text-xs text-red-600">
                  Lowercase letters, digits and underscores only; must start with a letter.
                </span>
              )}
            </label>
          </div>


          </div>}
          {step === 2 && <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="font-medium text-slate-900">{name}</p>
              <p className="mt-1 text-slate-600">{connections.find((c) => c.id === connectionId)?.name ?? SOURCE_TYPE_LABELS[sourceType]} → {destination === "ducklake" ? "Lakehouse" : "Project warehouse"} · {dataset}</p>
              <p className="mt-1 text-xs text-slate-500">{tables.join(", ")} · {projects.find((p) => p.id === projectId)?.name}</p>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">When this load runs</span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={writeDisposition}
                onChange={(e) => setWriteDisposition(e.target.value)}
              >
                {Object.keys(DISPOSITION_HELP).map((d) => (
                  <option key={d} value={d}>{{ append: "Add rows (append)", replace: "Replace all rows", merge: "Update matching rows (merge)" }[d]}</option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-gray-500">{DISPOSITION_HELP[writeDisposition]}</span>
            </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Track new rows using (optional)</span>
              <Input
                value={cursorField}
                onChange={(e) => setCursorField(e.target.value)}
                placeholder={sourceType === "filesystem" ? "modification_date" : "updated_at"}
              />
              <span className="mt-1 block text-xs text-gray-500">
                Use a timestamp or increasing ID, such as updated_at. Leave blank to read all rows on every run. Adding rows without tracking changes can create duplicates.
                {sourceType === "rest_api" && (
                  <> For an API this is a path into each record, so a nested field is written <code>attributes.updated_at</code>.</>
                )}
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


          {sourceType === "rest_api" && cursorField.trim() && (
            <div className="space-y-3 rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-700">Send the last tracked value to the API</p>
              {tables.map((table) => <label key={table} className="block text-sm">
                <span className="mb-1 block text-slate-600">{table}: query parameter (optional)</span>
                <Input placeholder="updated_since" value={(sourceConfig as RestSourceConfig).resources?.find((resource) => resource.name === table)?.incremental_param ?? ""} onChange={(event) => {
                  const config = sourceConfig as RestSourceConfig
                  setSourceConfig({ ...config, resources: (config.resources ?? []).map((resource) => resource.name === table ? { ...resource, incremental_param: event.target.value } : resource) })
                }} />
              </label>)}
              <p className="text-xs text-slate-500">Without a query parameter, the API may return all pages before rows are filtered.</p>
            </div>
          )}

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


            <p className="text-xs text-slate-500">Saving creates a reusable load. Data moves only when you select Run load.</p>
          </div>}
          {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <DialogFooter className="shrink-0 border-t border-slate-100 pt-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          {step > 0 && <Button variant="outline" onClick={() => { setError(null); setStep(step - 1) }} disabled={saving}>Back</Button>}
          {step < 2 ? <Button onClick={nextStep}>Continue</Button> : <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {existing ? "Save changes" : "Save load"}
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
