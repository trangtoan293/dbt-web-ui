"use client"

import React from "react"
import { Input } from "@/components-v2/ui/input"

export interface RestResource {
  name: string
  path?: string
  data_selector?: string
  params?: Record<string, unknown>
  /**
   * The query parameter that carries the cursor's last value. dlt sends it via
   * `incremental.start_param`; without one the cursor only removes duplicates
   * after every page has been fetched.
   */
  incremental_param?: string
}

export interface RestSourceConfig {
  base_url?: string
  paginator?: { type?: string }
  resources?: RestResource[]
}

interface Props {
  /** The source's table list: one endpoint per table, so the two cannot drift. */
  tables: string[]
  config: RestSourceConfig
  onChange: (next: RestSourceConfig) => void
  /** Whether a cursor field is set, which is what makes the param useful. */
  hasCursor: boolean
  /** True when the chosen connection already carries a base URL. */
  baseUrlFromConnection: boolean
}

const PAGINATORS = [
  ["auto", "Detect automatically"],
  ["json_link", "Next-page link in the body"],
  ["header_link", "Next-page link in the Link header"],
  ["offset", "offset & limit parameters"],
  ["page_number", "page number parameter"],
  ["cursor", "Cursor token in the body"],
  ["single_page", "One page, no pagination"],
] as const

const SELECT_CLS = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm"

export default function RestSourceFields({
  tables,
  config,
  onChange,
  hasCursor,
  baseUrlFromConnection,
}: Props): React.ReactElement {
  // Resources are derived from the table list rather than edited as their own
  // list: the names become destination tables, and two lists of the same names
  // is two places to forget one.
  const byName = new Map((config.resources ?? []).map((r) => [r.name, r]))

  function update(name: string, patch: Partial<RestResource>) {
    const next = tables.map((table) => ({
      name: table,
      ...(byName.get(table) ?? {}),
      ...(table === name ? patch : {}),
    }))
    onChange({ ...config, resources: next })
  }

  return (
    <div className="space-y-4 rounded-md border border-gray-200 p-3">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">
          Base URL{baseUrlFromConnection ? " (optional)" : ""}
        </span>
        <Input
          value={config.base_url ?? ""}
          onChange={(e) => onChange({ ...config, base_url: e.target.value })}
          placeholder="https://api.example.com/v1"
        />
        <span className="mt-1 block text-xs text-gray-500">
          {baseUrlFromConnection
            ? "Leave blank to use the connection's base URL."
            : "Endpoint paths below are relative to this."}
        </span>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Pagination</span>
        <select
          className={SELECT_CLS}
          value={config.paginator?.type ?? "auto"}
          onChange={(e) => onChange({ ...config, paginator: { type: e.target.value } })}
        >
          {PAGINATORS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      {tables.length === 0 ? (
        <p className="text-xs text-amber-700">
          Add a table name above; each one becomes an endpoint to read.
        </p>
      ) : (
        <div className="space-y-3">
          {tables.map((table) => {
            const resource = byName.get(table) ?? { name: table }
            return (
              <div key={table} className="rounded-md bg-gray-50 p-3">
                <p className="mb-2 text-xs font-semibold text-gray-700">{table}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block text-xs">
                    <span className="mb-1 block text-gray-600">Endpoint path</span>
                    <Input
                      value={resource.path ?? ""}
                      onChange={(e) => update(table, { path: e.target.value })}
                      placeholder={table}
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="mb-1 block text-gray-600">Records are under</span>
                    <Input
                      value={resource.data_selector ?? ""}
                      onChange={(e) => update(table, { data_selector: e.target.value })}
                      placeholder="data"
                    />
                  </label>
                </div>
                {hasCursor && (
                  <label className="mt-2 block text-xs">
                    <span className="mb-1 block text-gray-600">Send the cursor as</span>
                    <Input
                      value={resource.incremental_param ?? ""}
                      onChange={(e) => update(table, { incremental_param: e.target.value })}
                      placeholder="updated_since"
                    />
                    <span className="mt-1 block text-gray-500">
                      Without this the cursor only removes duplicates after every page
                      has been fetched, which costs the same as no cursor at all.
                    </span>
                  </label>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
