"use client"

import React, { useCallback, useEffect, useState } from "react"
import { Loader2, Snowflake, UploadCloud } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Card, CardContent } from "@/components-v2/ui/card"
import { Input } from "@/components-v2/ui/input"
import EmptyState from "@/components-v2/shared/EmptyState"
import {
  getIcebergMeta,
  getProjects,
  publishIceberg,
  type IcebergPublishResult,
} from "@/lib/api-client"

// Mirrors _NAME_RE in dbt-runner/app/routers/lake.py, which is the enforcing side.
const SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

/** How each per-table outcome should read. The runner returns the raw string. */
function outcomeTone(outcome: string): string {
  if (outcome.startsWith("failed")) return "text-red-700"
  if (outcome === "unchanged") return "text-gray-500"
  return "text-green-700"
}

export default function LakehouseView(): React.ReactElement {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [projectId, setProjectId] = useState("")
  const [schema, setSchema] = useState("marts")
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<IcebergPublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getProjects()
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : []
        setProjects(list)
        setProjectId((current) => current || list[0]?.id || "")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load projects"))
    getIcebergMeta()
      .then((m) => setConfigured(Boolean(m?.configured)))
      .catch(() => setConfigured(false))
  }, [])

  const publish = useCallback(async () => {
    setError(null)
    setResult(null)
    if (!projectId) return setError("Choose a project")
    if (!SCHEMA_PATTERN.test(schema.trim())) {
      return setError("Schema must start with a letter or underscore, then letters, digits, _ or $")
    }
    setPublishing(true)
    try {
      setResult(await publishIceberg(projectId, schema.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish failed")
    } finally {
      setPublishing(false)
    }
  }, [projectId, schema])

  if (configured === false) {
    return (
      <EmptyState
        icon={Snowflake}
        title="Iceberg publishing is not configured"
        description="This deployment has no lakehouse catalog, so there is nothing to publish from. Set LAKE_CATALOG_URL (or ICEBERG_CATALOG_URL) and restart dbt-runner."
      />
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <p className="text-sm text-gray-600">
            Copies a lake schema out as Iceberg tables, so Spark, Trino, Athena and the rest can
            read your marts &mdash; DuckLake itself is readable only by DuckDB. A schema that was
            only appended to publishes just its new Parquet; a table dbt rebuilt is replaced.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Project</span>
              <select
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.length === 0 && <option value="">No projects</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Lake schema</span>
              <Input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="marts" />
              <span className="mt-1 block text-xs text-gray-500">
                The schema dbt builds into, e.g. <code>marts</code>.
              </span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={publish} disabled={publishing || !projectId}>
              {publishing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="mr-2 h-4 w-4" />
              )}
              {publishing ? "Publishing" : "Publish to Iceberg"}
            </Button>
            <span className="text-xs text-gray-500">
              To publish on every scheduled run instead, set &ldquo;Publish to Iceberg&rdquo; on the
              schedule.
            </span>
          </div>

          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <div className="text-sm font-medium text-gray-700">
              Published <code>{result.schema}</code>
              {result.namespace && (
                <span className="font-normal text-gray-500"> as {result.namespace}</span>
              )}
            </div>
            {Object.keys(result.published).length === 0 ? (
              <p className="text-sm text-gray-500">
                No tables in that lake schema yet &mdash; run dbt first.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 text-sm">
                {Object.entries(result.published).map(([table, outcome]) => (
                  <li key={table} className="flex items-center justify-between py-1.5">
                    <code className="text-gray-700">{table}</code>
                    <span className={outcomeTone(outcome)}>{outcome}</span>
                  </li>
                ))}
              </ul>
            )}
            {result.warehouse && (
              <p className="text-xs text-gray-500">
                Warehouse: <code>{result.warehouse}</code>
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
