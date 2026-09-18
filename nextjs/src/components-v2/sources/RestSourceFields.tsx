"use client"

import React, { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import { probeRestEndpoint, type RestProbeResult } from "@/lib/api-client"

export interface RestResource {
  name: string
  path?: string
  data_selector?: string
  params?: Record<string, unknown>
  /**
   * The query parameter that carries the cursor's last value. dlt sends it via
   * `incremental.start_param`; without one the cursor only removes duplicates
   * after every page has been fetched. Edited on the last step, beside the
   * cursor field itself - there is nothing to send before one is chosen.
   */
  incremental_param?: string
}

export interface RestSourceConfig {
  base_url?: string
  /** `limit` is required by dlt's offset paginator and by nothing else. */
  paginator?: { type?: string; limit?: number | string }
  resources?: RestResource[]
}

interface Props {
  /** The source's table list: one endpoint per table, so the two cannot drift. */
  tables: string[]
  config: RestSourceConfig
  onChange: (next: RestSourceConfig) => void
  /** True when the chosen connection already carries a base URL. */
  baseUrlFromConnection: boolean
  /** The `rest` connection supplying the credential, if there is one. */
  connectionId: string
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

/** The URL a resource will actually be fetched from, as dlt joins it. */
function requestUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "")
  if (!base) return ""
  return `${base}/${path.trim().replace(/^\/+/, "")}`
}

export default function RestSourceFields({
  tables,
  config,
  onChange,
  baseUrlFromConnection,
  connectionId,
}: Props): React.ReactElement {
  // Keyed by resource: each endpoint is tested on its own, and one result must
  // not read as another's.
  const [probes, setProbes] = useState<Record<string, RestProbeResult>>({})
  const [probing, setProbing] = useState<string | null>(null)
  // Resources are derived from the table list rather than edited as their own
  // list: the names become destination tables, and two lists of the same names
  // is two places to forget one.
  const byName = new Map((config.resources ?? []).map((r) => [r.name, r]))
  const paginatorType = config.paginator?.type ?? "auto"

  async function probe(table: string, path: string) {
    setProbing(table)
    try {
      const result = await probeRestEndpoint({
        connectionId,
        baseUrl: config.base_url,
        path,
      })
      setProbes((prev) => ({ ...prev, [table]: result }))
    } catch (e) {
      setProbes((prev) => ({
        ...prev,
        [table]: { success: false, message: e instanceof Error ? e.message : "Test failed" },
      }))
    } finally {
      setProbing(null)
    }
  }

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
            : "The part every endpoint below shares. Put the per-resource part in Endpoint path, not here."}
        </span>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Pagination</span>
        <select
          className={SELECT_CLS}
          value={paginatorType}
          onChange={(e) => {
            const type = e.target.value
            // `limit` belongs to the offset paginator only; carrying it to
            // another type would be a field dlt rejects.
            onChange({
              ...config,
              paginator: type === "offset" ? { type, limit: config.paginator?.limit ?? 100 } : { type },
            })
          }}
        >
          {PAGINATORS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {paginatorType === "offset" && (
          <span className="mt-2 block">
            <span className="mb-1 block text-xs text-gray-600">Records per page</span>
            <Input
              type="number"
              min={1}
              value={config.paginator?.limit ?? ""}
              onChange={(e) =>
                onChange({
                  ...config,
                  paginator: { type: "offset", limit: e.target.value },
                })
              }
              placeholder="100"
            />
            <span className="mt-1 block text-xs text-gray-500">
              Required — this becomes the API&apos;s <code>limit</code> parameter.
            </span>
          </span>
        )}
      </label>

      {tables.length === 0 ? (
        <p className="text-xs text-amber-700">
          Add a resource name above; each one becomes a table in the destination.
        </p>
      ) : (
        <div className="space-y-3">
          {tables.map((table) => {
            const resource = byName.get(table) ?? { name: table }
            const url = requestUrl(config.base_url ?? "", resource.path || table)
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
                    <span className="mt-1 block text-gray-500">
                      Defaults to the resource name.
                    </span>
                  </label>
                  <label className="block text-xs">
                    <span className="mb-1 block text-gray-600">Records are under</span>
                    <Input
                      value={resource.data_selector ?? ""}
                      onChange={(e) => update(table, { data_selector: e.target.value })}
                      placeholder="(auto-detect)"
                    />
                    <span className="mt-1 block text-gray-500">
                      Leave blank unless the rows sit under a key, e.g. <code>data</code>
                      {" "}in <code>{'{"data": [...]}'}</code>.
                    </span>
                  </label>
                </div>
                {/* The whole point of the two fields above is the URL they make,
                    and a wrong join is a 404 nothing else in this form reveals. */}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="break-all text-xs text-slate-500">
                    {url ? (
                      <>Will request <code className="text-slate-700">GET {url}</code></>
                    ) : (
                      "Enter a base URL to see the request this will make."
                    )}
                  </p>
                  {url && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={probing !== null}
                      onClick={() => probe(table, resource.path || table)}
                    >
                      {probing === table ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                    </Button>
                  )}
                </div>
                {probes[table] && (
                  <div
                    className={`mt-2 rounded-md px-2 py-1.5 text-xs ${
                      probes[table].success
                        ? "bg-emerald-50 text-emerald-900"
                        : "bg-red-50 text-red-800"
                    }`}
                  >
                    <p>{probes[table].message}</p>
                    {probes[table].success && (
                      <>
                        {/* The answer to "why did it load zero rows": an empty
                            selector is a real answer, so it is offered to apply
                            rather than only shown. */}
                        {(probes[table].data_selector ?? "") !== (resource.data_selector ?? "") && (
                          <button
                            type="button"
                            className="mt-1 font-medium underline"
                            onClick={() =>
                              update(table, { data_selector: probes[table].data_selector ?? "" })
                            }
                          >
                            Set “Records are under” to{" "}
                            {probes[table].data_selector
                              ? `“${probes[table].data_selector}”`
                              : "blank (records are at the top level)"}
                          </button>
                        )}
                        {(probes[table].fields?.length ?? 0) > 0 && (
                          <p className="mt-1 break-all text-emerald-800">
                            Fields: {probes[table].fields!.slice(0, 12).join(", ")}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
