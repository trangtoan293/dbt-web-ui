"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Boxes, Database, Loader2, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import EmptyState from "@/components-v2/shared/EmptyState"
import { dbtApi } from "@/lib/api"
import { cn } from "@/lib/utils"

interface CatalogBrowserProps {
  projectId: string
}

interface Column {
  name: string
  data_type?: string | null
  description?: string | null
}

interface Entry {
  kind: "model" | "source"
  key: string
  name: string
  path: string
  description?: string | null
  columns: Column[]
}

/**
 * Searchable list of the project's models, sources and their columns.
 *
 * Reads /dbt/intellisense, the same normalised manifest+catalog the editor's
 * autocomplete uses - so there is no second metadata path to keep in step, and
 * a project that has never been parsed says so instead of looking empty.
 */
export default function CatalogBrowser({ projectId }: CatalogBrowserProps): React.ReactElement {
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<string>("")
  const [catalogAvailable, setCatalogAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await dbtApi.getIntellisense(projectId)
      setStatus(response.status ?? "")
      setCatalogAvailable(Boolean(response.catalog_available))
      const models: Entry[] = (response.models ?? []).map((model) => ({
        kind: "model",
        key: model.unique_id,
        name: model.name,
        path: model.path,
        description: model.description,
        columns: model.columns ?? [],
      }))
      const sources: Entry[] = (response.sources ?? []).map((source) => ({
        kind: "source",
        key: source.unique_id,
        name: `${source.source_name}.${source.table_name}`,
        path: source.path,
        description: source.description,
        columns: source.columns ?? [],
      }))
      setEntries([...models, ...sources])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog")
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    setSelected(null)
    load()
  }, [load])

  // Columns are searched too: "which model has customer_lifetime_value" is the
  // question a catalog is for.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        entry.description?.toLowerCase().includes(needle) ||
        entry.columns.some((column) => column.name.toLowerCase().includes(needle)),
    )
  }, [entries, query])

  const active = useMemo(
    () => filtered.find((entry) => entry.key === selected) ?? filtered[0] ?? null,
    [filtered, selected],
  )

  const matchingColumns = useCallback(
    (entry: Entry) => {
      const needle = query.trim().toLowerCase()
      if (!needle) return entry.columns
      const hits = entry.columns.filter((column) =>
        column.name.toLowerCase().includes(needle),
      )
      return hits.length > 0 ? hits : entry.columns
    },
    [query],
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={Boxes}
          title="Unable to load the catalog"
          description={error}
          action={
            <Button variant="outline" onClick={load}>
              <RefreshCw className="mr-2 h-4 w-4" /> Retry
            </Button>
          }
        />
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={Boxes}
          title="Nothing in the catalog yet"
          description={
            status === "missing"
              ? "This project has no manifest. Run dbt parse or dbt docs generate, then reload."
              : "No models or sources were found in this project's manifest."
          }
          action={
            <Button variant="outline" onClick={load}>
              <RefreshCw className="mr-2 h-4 w-4" /> Reload
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models, sources and columns"
            className="h-9 pl-8"
          />
        </div>
        <Button variant="outline" size="sm" onClick={load} title="Reload catalog">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {!catalogAvailable && (
        <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          Column types come from catalog.json. Run <code>dbt docs generate</code> to fill them in.
        </p>
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="min-h-0 overflow-auto border-r border-gray-200">
          {filtered.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">Nothing matches “{query}”.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {filtered.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    onClick={() => setSelected(entry.key)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-gray-50",
                      active?.key === entry.key && "bg-blue-50",
                    )}
                  >
                    {entry.kind === "model" ? (
                      <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-[#0078D4]" />
                    ) : (
                      <Database className="mt-0.5 h-4 w-4 shrink-0 text-[#038387]" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-gray-900">{entry.name}</span>
                      <span className="block truncate text-xs text-gray-400">
                        {entry.columns.length} column(s)
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-h-0 overflow-auto p-4">
          {active ? (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{active.name}</p>
                <p className="mt-0.5 font-mono text-xs text-gray-400">{active.path}</p>
                {active.description && (
                  <p className="mt-2 text-sm text-gray-600">{active.description}</p>
                )}
                {active.kind === "model" && (
                  <Button variant="ghost" size="sm" className="mt-2 -ml-2" asChild>
                    <Link href={`/develop/${projectId}`}>Open in Develop</Link>
                  </Button>
                )}
              </div>

              {active.columns.length === 0 ? (
                <p className="text-sm text-gray-500">No columns recorded for this node.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border border-gray-200">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Column</th>
                        <th className="px-3 py-2 text-left font-medium">Type</th>
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {matchingColumns(active).map((column) => (
                        <tr key={column.name}>
                          <td className="px-3 py-1.5 font-mono text-xs text-gray-900">
                            {column.name}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-gray-500">
                            {column.data_type || "—"}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-gray-500">
                            {column.description || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">Select a model or source.</p>
          )}
        </div>
      </div>
    </div>
  )
}
