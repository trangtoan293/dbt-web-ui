"use client"

import Link from "next/link"
import React, { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import { createConnection, setProjectLakehouse } from "@/lib/api-client"
import { qualifiedTableNames, type Draft } from "@/lib/ingest-draft"

type Project = { id: string; name: string; lakehouseConnectionId?: string | null }

interface Props {
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
  projects: Project[]
  lakehouseConfigured: boolean
  onProjectsChanged: () => Promise<void> | void
}

const DESTINATION_HELP: Record<string, string> = {
  ducklake:
    "Parquet on shared storage with a DuckLake catalog that dbt and other engines read. The usual home for raw loads.",
  connection:
    "The database this project runs dbt on. Only DuckDB and PostgreSQL warehouses can be loaded into directly.",
}

/**
 * Where the rows land, and what they will be called when they get there.
 *
 * The name preview is the addition: a schema field alone never said whether the
 * load was about to write beside an existing table or on top of one.
 */
export default function DestinationStep({
  draft,
  onChange,
  projects,
  lakehouseConfigured,
  onProjectsChanged,
}: Props): React.ReactElement {
  const [creatingLake, setCreatingLake] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const project = projects.find((candidate) => candidate.id === draft.projectId)
  const lakeBlocked = Boolean(project) && !project?.lakehouseConnectionId
  const lakeUnavailable = draft.destination === "ducklake" && lakeBlocked

  /**
   * Create a lakehouse for this project without leaving the wizard.
   *
   * A managed lake needs nothing from the user: dbt-runner derives the catalog
   * schema and the data directory from the connection id. Sending someone off
   * to Connections, then Project Settings, and back is the whole feature's
   * cliff — and every step on it had one right answer.
   */
  async function createLakehouse() {
    if (!project) return
    setCreatingLake(true)
    setError(null)
    try {
      const lake = await createConnection({
        connectionType: "ducklake",
        name: `${project.name} lakehouse`,
        host: "",
        port: 0,
        database: "",
        username: "",
        extraConfig: { mode: "managed" },
      })
      await setProjectLakehouse(project.id, { connectionId: lake.id })
      await onProjectsChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the lakehouse")
    } finally {
      setCreatingLake(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Project</span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={draft.projectId}
            onChange={(event) => onChange({ projectId: event.target.value })}
          >
            <option value="">Select…</option>
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          {projects.length === 0 && (
            <span className="mt-1 block text-xs text-slate-600">
              A load belongs to a dbt project.{" "}
              <Link href="/develop/new" className="text-[#0078D4] underline">
                Create one
              </Link>{" "}
              first.
            </span>
          )}
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Write into</span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={draft.destination}
            onChange={(event) =>
              onChange({ destination: event.target.value as Draft["destination"] })
            }
          >
            <option value="ducklake" disabled={!lakehouseConfigured}>
              Lakehouse{lakehouseConfigured ? "" : " — not available on this server"}
            </option>
            <option value="connection">The project&apos;s own warehouse</option>
          </select>
          <span className="mt-1 block text-xs text-slate-500">
            {DESTINATION_HELP[draft.destination]}
          </span>
        </label>
      </div>

      {lakeUnavailable && (
        <div role="alert" className="space-y-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            “{project?.name}” has no lakehouse yet. Set one up and this load can write to it —
            storage and catalog are created for you.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={createLakehouse} disabled={creatingLake}>
              {creatingLake && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Set up a lakehouse
            </Button>
            <button
              type="button"
              className="text-xs font-medium underline"
              onClick={() => onChange({ destination: "connection" })}
              disabled={creatingLake}
            >
              or write into the project&apos;s own warehouse
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Destination schema</span>
          <Input
            value={draft.dataset}
            placeholder="raw_core"
            onChange={(event) => onChange({ dataset: event.target.value.toLowerCase() })}
          />
        </label>
        {draft.destination === "ducklake" && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Partition by</span>
            <Input
              value={draft.partitionBy}
              placeholder="month(updated_at)"
              onChange={(event) => onChange({ partitionBy: event.target.value })}
            />
            <span className="mt-1 block text-xs text-slate-500">
              Optional, but at scale it is the difference between reading one month of Parquet
              and reading the whole table. A column, or year/month/day/hour(column).
            </span>
          </label>
        )}
      </div>

      {draft.tables.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-800">
            Will write {draft.tables.length} table{draft.tables.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-2 grid gap-1 font-mono text-xs text-slate-600 sm:grid-cols-2">
            {qualifiedTableNames(draft).map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}
