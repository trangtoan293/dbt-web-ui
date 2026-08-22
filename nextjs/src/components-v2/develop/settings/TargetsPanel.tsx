"use client"

import React, { useCallback, useEffect, useState } from "react"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import {
  createProjectTarget,
  deleteProjectTarget,
  getConnections,
  getProjectTargets,
  type ProjectTargetRow,
} from "@/lib/api-client"

interface ConnectionOption {
  id: string
  name: string
  connectionType: string
}

interface TargetsPanelProps {
  projectId: string
  /** Called after a target is added or removed, so the toolbar selector reloads. */
  onChanged?: () => void
}

/**
 * Manages the project's extra profiles.yml outputs.
 *
 * `dev` is the project's attached connection and is not a row here - changing
 * it means changing the project's connection, which lives on the General tab.
 */
export default function TargetsPanel({ projectId, onChanged }: TargetsPanelProps): React.ReactElement {
  const [targets, setTargets] = useState<ProjectTargetRow[]>([])
  const [connections, setConnections] = useState<ConnectionOption[]>([])
  const [name, setName] = useState("")
  const [connectionId, setConnectionId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setTargets(await getProjectTargets(projectId))
    } catch {
      setTargets([])
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    getConnections()
      .then((rows) =>
        setConnections(
          (Array.isArray(rows) ? rows : [])
            // Dremio sources come back from the same endpoint but are not
            // connections rows, so they cannot back a target.
            .filter((row) => row?._sourceTable !== "dremio_source")
            .map((row) => ({ id: row.id, name: row.name, connectionType: row.connectionType })),
        ),
      )
      .catch(() => setConnections([]))
  }, [])

  async function addTarget() {
    setBusy(true)
    setError(null)
    try {
      await createProjectTarget({ projectId, name: name.trim(), connectionId })
      setName("")
      setConnectionId("")
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add target")
    } finally {
      setBusy(false)
    }
  }

  async function removeTarget(id: string) {
    setBusy(true)
    setError(null)
    try {
      await deleteProjectTarget(id)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove target")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        Each target is one profiles.yml output. Use them to run the same models against a second
        warehouse — <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">dbt run --target prod</code> —
        without a second project.
      </p>

      <div className="rounded-md border border-gray-200">
        <div className="flex items-center justify-between px-3 py-2 text-sm">
          <span className="font-mono text-xs text-gray-900">dev</span>
          <span className="text-xs text-gray-500">the project&apos;s connection</span>
        </div>
        {targets.map((target) => (
          <div
            key={target.id}
            className="flex items-center justify-between border-t border-gray-100 px-3 py-2 text-sm"
          >
            <span className="font-mono text-xs text-gray-900">{target.name}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">{target.connection?.name ?? "connection"}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => removeTarget(target.id)}
                className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                title={`Remove target ${target.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_1.2fr_auto]">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="prod"
          aria-label="Target name"
          className="h-9"
        />
        <select
          value={connectionId}
          onChange={(event) => setConnectionId(event.target.value)}
          aria-label="Target connection"
          className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm"
        >
          <option value="">Choose a connection</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name} ({connection.connectionType})
            </option>
          ))}
        </select>
        <Button size="sm" onClick={addTarget} disabled={busy || !name.trim() || !connectionId}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>

      <p className="text-xs text-gray-500">
        Lowercase letters, digits and underscores. Each target keeps its credential in its own
        environment variable, so two targets never authenticate with each other&apos;s password.
      </p>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  )
}
