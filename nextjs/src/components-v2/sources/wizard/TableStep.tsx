"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, Search, X } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import {
  getIngestConnectionTables,
  previewIngestSource,
  type IngestPreviewResult,
} from "@/lib/api-client"
import RestSourceFields, { type RestSourceConfig } from "@/components-v2/sources/RestSourceFields"
import { destinationTableName, tableDefaults, type Draft, type SourceKind } from "@/lib/ingest-draft"
import type { IngestTableConfig } from "@/lib/ingest-source-validation"

interface Props {
  kind: SourceKind
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
}

const DISPOSITIONS = [
  { value: "append", label: "Add rows" },
  { value: "merge", label: "Update matching" },
  { value: "replace", label: "Replace all" },
]

/** A filesystem load reads one directory, so its preview is not per table. */
const FILE_PREVIEW_KEY = "__files__"

/**
 * Choose the tables, and decide how each one keeps itself up to date.
 *
 * This screen replaces both the old "type a table name" chip list and the old
 * single Update rules step. The reason it is one screen and not two: the
 * settings that matter — the cursor above all — can only be chosen sensibly
 * with the table's columns in front of you, and they differ per table. Twelve
 * tables sharing one cursor column is not a thing real warehouses do.
 */
export default function TableStep({ kind, draft, onChange }: Props): React.ReactElement {
  const [available, setAvailable] = useState<string[] | null>(null)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [loadingTables, setLoadingTables] = useState(false)
  const [search, setSearch] = useState("")
  const [manual, setManual] = useState("")
  const [previews, setPreviews] = useState<Record<string, IngestPreviewResult>>({})
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)

  const isSql = kind.sourceType === "sql_database"
  const isFile = kind.sourceType === "filesystem"
  const previewKeyFor = useCallback(
    (table: string) => (isFile ? FILE_PREVIEW_KEY : table),
    [isFile],
  )

  // Browsing is automatic, not a button: the list is the point of the screen.
  useEffect(() => {
    if (!isSql || !draft.connectionId) return
    let cancelled = false
    setLoadingTables(true)
    setBrowseError(null)
    getIngestConnectionTables(draft.connectionId)
      .then((result) => {
        if (cancelled) return
        if (result.success) setAvailable(result.tables)
        else setBrowseError(result.message ?? "Could not read the table list")
      })
      .catch((error) => {
        if (!cancelled) setBrowseError(error instanceof Error ? error.message : "Could not read the table list")
      })
      .finally(() => !cancelled && setLoadingTables(false))
    return () => {
      cancelled = true
    }
  }, [isSql, draft.connectionId])

  const fetchPreview = useCallback(
    async (table: string) => {
      const key = previewKeyFor(table)
      setPreviewing(key)
      try {
        const result = await previewIngestSource({
          sourceType: isFile ? "filesystem" : "sql_database",
          connectionId: draft.connectionId || null,
          table: isFile ? undefined : table,
          sourceConfig: isFile ? draft.sourceConfig : null,
        })
        setPreviews((current) => ({ ...current, [key]: result }))
        return result
      } catch (error) {
        const failed: IngestPreviewResult = {
          success: false,
          message: error instanceof Error ? error.message : "Preview failed",
          columns: [],
          rows: [],
          primary_key: [],
          suggested_cursor: null,
          suggested_write_disposition: null,
          files: [],
        }
        setPreviews((current) => ({ ...current, [key]: failed }))
        return failed
      } finally {
        setPreviewing(null)
      }
    },
    [draft.connectionId, draft.sourceConfig, isFile, previewKeyFor],
  )

  function patchTable(table: string, patch: Partial<IngestTableConfig>) {
    onChange({
      tableConfig: { ...draft.tableConfig, [table]: { ...draft.tableConfig[table], ...patch } },
    })
  }

  // Selecting a table reads its columns and fills its row in, which is the whole
  // difference between proposing settings and asking for them.
  async function addTable(table: string) {
    const name = table.trim()
    if (!name || draft.tables.includes(name)) return
    const tables = isFile ? [name] : [...draft.tables, name]
    onChange({ tables })
    setFocused(name)
    const key = previewKeyFor(name)
    const preview = previews[key] ?? (await fetchPreview(name))
    if (preview.success) {
      onChange({
        tables,
        tableConfig: { ...draft.tableConfig, [name]: tableDefaults(preview) },
      })
    }
  }

  function removeTable(table: string) {
    const { [table]: _dropped, ...rest } = draft.tableConfig
    onChange({ tables: draft.tables.filter((t) => t !== table), tableConfig: rest })
    if (focused === table) setFocused(null)
  }

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = available ?? []
    return needle ? list.filter((name) => name.toLowerCase().includes(needle)) : list
  }, [available, search])

  const focusedPreview = focused ? previews[previewKeyFor(focused)] : undefined

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        {/* --- left: what is there to load --- */}
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 p-3">
            {isSql ? (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  aria-label="Search source tables"
                  className="h-9 w-full rounded-md border border-slate-200 pl-8 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]"
                  placeholder="Search tables…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            ) : (
              <div className="flex gap-2">
                <Input
                  value={manual}
                  placeholder={isFile ? "Destination table" : "Resource name"}
                  onChange={(event) => setManual(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      addTable(manual)
                      setManual("")
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    addTable(manual)
                    setManual("")
                  }}
                >
                  Add
                </Button>
              </div>
            )}
          </div>

          {isSql && (
            <>
              <div className="flex items-center justify-between px-3 py-2 text-xs text-slate-500">
                <span>
                  {loadingTables
                    ? "Reading the table list…"
                    : `${draft.tables.length} of ${available?.length ?? 0} selected`}
                </span>
                {shown.length > 0 && shown.length <= 50 && (
                  <button
                    type="button"
                    className="font-medium text-[#0078D4] hover:underline"
                    onClick={() => shown.forEach((name) => addTable(name))}
                  >
                    Select all shown
                  </button>
                )}
              </div>
              <div className="max-h-80 overflow-y-auto px-2 pb-2">
                {loadingTables && (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                  </div>
                )}
                {browseError && (
                  <p role="alert" className="m-2 rounded bg-red-50 p-2 text-xs text-red-700">
                    {browseError}
                  </p>
                )}
                {!loadingTables &&
                  shown.map((name) => (
                    <label
                      key={name}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        checked={draft.tables.includes(name)}
                        onChange={(event) =>
                          event.target.checked ? addTable(name) : removeTable(name)
                        }
                      />
                      <span className="truncate font-mono text-xs text-slate-700">{name}</span>
                    </label>
                  ))}
                {!loadingTables && !browseError && shown.length === 0 && (
                  <p className="p-4 text-center text-xs text-slate-500">
                    {available === null
                      ? "Choose a connection to list its tables."
                      : "No table matches that search."}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* --- right: how each one updates --- */}
        <div className="min-w-0 rounded-lg border border-slate-200 bg-white">
          {draft.tables.length === 0 ? (
            <p className="p-10 text-center text-sm text-slate-500">
              Nothing selected yet. Pick a table on the left and its settings appear here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 text-left font-medium">Table</th>
                    <th className="px-3 py-2 text-left font-medium">Updates</th>
                    <th className="px-3 py-2 text-left font-medium">Tracks changes on</th>
                    <th className="px-3 py-2 text-left font-medium">Primary key</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {draft.tables.map((table) => {
                    const config = draft.tableConfig[table] ?? {}
                    const preview = previews[previewKeyFor(table)]
                    const columns = preview?.columns ?? []
                    const disposition = config.writeDisposition ?? draft.writeDisposition
                    const declaredKey = (preview?.primary_key ?? []).length > 0
                    return (
                      <tr
                        key={table}
                        onClick={() => {
                          setFocused(table)
                          if (!previews[previewKeyFor(table)]) fetchPreview(table)
                        }}
                        className={`cursor-pointer align-top ${focused === table ? "bg-blue-50/50" : ""}`}
                      >
                        <td className="px-3 py-2">
                          <p className="font-mono text-xs text-slate-800">{table}</p>
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            → {destinationTableName(table)}
                          </p>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            className="w-full rounded border border-slate-200 px-2 py-1 text-xs"
                            value={disposition}
                            onChange={(event) =>
                              patchTable(table, { writeDisposition: event.target.value })
                            }
                          >
                            {DISPOSITIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            className="w-full rounded border border-slate-200 px-2 py-1 text-xs"
                            value={config.cursorField ?? ""}
                            onChange={(event) =>
                              patchTable(table, { cursorField: event.target.value || null })
                            }
                          >
                            <option value="">— nothing, re-read every run</option>
                            {columns.map((column) => (
                              <option key={column.name} value={column.name}>
                                {column.name} ({column.type})
                              </option>
                            ))}
                          </select>
                          {!config.cursorField && (
                            <p className="mt-1 text-[11px] text-amber-700">
                              Reads the whole table on every run.
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {declaredKey ? (
                            <p className="font-mono text-xs text-slate-600">
                              {(config.primaryKey ?? []).join(", ")}
                              <span className="ml-1 text-[11px] text-slate-400">from source</span>
                            </p>
                          ) : (
                            <Input
                              className="h-7 text-xs"
                              placeholder={disposition === "merge" ? "required" : "optional"}
                              value={(config.primaryKey ?? []).join(", ")}
                              onChange={(event) =>
                                patchTable(table, {
                                  primaryKey: event.target.value
                                    .split(",")
                                    .map((part) => part.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            aria-label={`Remove ${table}`}
                            className="text-slate-400 hover:text-red-600"
                            onClick={(event) => {
                              event.stopPropagation()
                              removeTable(table)
                            }}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* A REST resource's endpoint and its test only mean anything once the
          resource has a name, so they live here rather than on the previous
          step, where the list was still empty. */}
      {kind.sourceType === "rest_api" && (
        <RestSourceFields
          tables={draft.tables}
          config={draft.sourceConfig as RestSourceConfig}
          onChange={(next) => onChange({ sourceConfig: next as Record<string, unknown> })}
          baseUrlFromConnection={Boolean(draft.connectionId)}
          connectionId={draft.connectionId}
        />
      )}

      {/* --- the rows themselves: the question every other control depends on --- */}
      {focused && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
            <p className="text-sm font-medium text-slate-800">
              {focused}
              <span className="ml-2 text-xs font-normal text-slate-500">first rows</span>
            </p>
            {previewing && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          </div>
          {focusedPreview?.success === false ? (
            <p role="alert" className="p-4 text-sm text-red-700">
              {focusedPreview.message}
            </p>
          ) : focusedPreview ? (
            <div className="overflow-x-auto">
              {focusedPreview.files.length > 0 && (
                <p className="px-4 pt-3 text-xs text-slate-500">
                  {focusedPreview.files.length} file(s) match: {focusedPreview.files.slice(0, 5).join(", ")}
                </p>
              )}
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-slate-500">
                    {focusedPreview.columns.map((column) => (
                      <th key={column.name} className="whitespace-nowrap px-3 py-2 font-medium">
                        {column.name}
                        <span className="ml-1 font-normal text-slate-400">{column.type}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {focusedPreview.rows.map((row, index) => (
                    <tr key={index}>
                      {focusedPreview.columns.map((column) => (
                        <td key={column.name} className="whitespace-nowrap px-3 py-1.5 text-slate-700">
                          {row[column.name] === null ? (
                            <span className="text-slate-300">null</span>
                          ) : (
                            String(row[column.name])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {focusedPreview.rows.length === 0 && (
                <p className="p-4 text-center text-xs text-slate-500">
                  This source has no rows yet.
                </p>
              )}
            </div>
          ) : (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
