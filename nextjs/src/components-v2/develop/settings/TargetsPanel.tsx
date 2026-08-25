"use client"

import React, { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import {
  createProjectTarget,
  deleteProjectTarget,
  getProjectTargets,
  updateProjectTarget,
  type ProjectTargetRow,
} from "@/lib/api-client"
import ConnectionCheckDialog from "@/components-v2/develop/ConnectionCheckDialog"
import type { Connection } from "@/components-v2/develop/types"

interface TargetsPanelProps {
  projectId: string
  /** Every connection the user owns, for both the dev row and a new target. */
  connections: Connection[]
  /** The project's own connection, which is target `dev`. */
  activeConnectionId: string
  /** Attaches a connection to the project, i.e. redefines `dev`. */
  onSelectConnection: (connectionId: string) => void
  disabled?: boolean
  /** Called after a target is added or removed, so the toolbar selector reloads. */
  onChanged?: () => void
}

/**
 * Every profiles.yml output this project has, in one list.
 *
 * `dev` is the project's own connection rather than a project_targets row, but
 * that is a storage detail: to the person running dbt it is one more target,
 * and splitting it into a separate "Connection" control was how someone could
 * change the connection while every command still ran on a target they had
 * picked days earlier.
 */
export default function TargetsPanel({
  projectId,
  connections,
  activeConnectionId,
  onSelectConnection,
  disabled = false,
  onChanged,
}: TargetsPanelProps): React.ReactElement {
  const [targets, setTargets] = useState<ProjectTargetRow[]>([])
  const [name, setName] = useState("")
  const [connectionId, setConnectionId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Filled by the Check button: one live result per target, keyed by name.
  const [reachable, setReachable] = useState<Record<string, { ok: boolean; message?: string | null }>>({})

  /** A dot beside a target, once it has been checked. */
  function Status({ name }: { name: string }): React.ReactElement | null {
    const status = reachable[name]
    if (!status) return null
    const Icon = status.ok ? CheckCircle2 : XCircle
    return (
      <span title={status.message ?? (status.ok ? "Reachable" : "Unreachable")}>
        <Icon className={`h-3.5 w-3.5 shrink-0 ${status.ok ? "text-green-600" : "text-red-600"}`} />
      </span>
    )
  }

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

  // A legacy dremio_sources row can back the project's own connection but is
  // not a connections row, so it cannot back an extra target.
  const targetConnections = connections.filter((row) => row.sourceTable !== "dremio_source")

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

  /** Repoint an existing target at another connection. */
  async function retarget(target: ProjectTargetRow, nextConnectionId: string) {
    if (!nextConnectionId || nextConnectionId === target.connectionId) return
    setBusy(true)
    setError(null)
    try {
      await updateProjectTarget({
        id: target.id,
        projectId,
        name: target.name,
        connectionId: nextConnectionId,
      })
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update target")
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
        Each target is one profiles.yml output, and the toolbar picks which one every dbt command
        runs against. <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">dev</code> is this
        project&apos;s own connection; add more to run the same models against a second warehouse
        without a second project.
      </p>

      <div className="rounded-md border border-gray-200">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <span className="font-mono text-xs text-gray-900">dev</span>
          <Status name="dev" />
          <select
            aria-label="Connection for target dev"
            value={activeConnectionId}
            onChange={(event) => onSelectConnection(event.target.value)}
            disabled={disabled}
            className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-xs disabled:opacity-50"
          >
            <option value="">None — dbt commands will not run</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} ({connection.type})
              </option>
            ))}
          </select>
          <ConnectionCheckDialog
            projectId={projectId}
            compact
            onResult={(result) =>
              setReachable(
                Object.fromEntries(
                  (result.targets ?? []).map((target) => [
                    target.name,
                    { ok: target.ok, message: target.message },
                  ]),
                ),
              )
            }
          />
        </div>
        {targets.map((target) => (
          <div
            key={target.id}
            className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-3 py-2 text-sm"
          >
            <span className="font-mono text-xs text-gray-900">{target.name}</span>
            <Status name={target.name} />
            <select
              aria-label={`Connection for target ${target.name}`}
              value={target.connectionId}
              onChange={(event) => retarget(target, event.target.value)}
              disabled={disabled || busy}
              className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-xs disabled:opacity-50"
            >
              {/* A connection the user can no longer see would otherwise render
                  as the first option, silently repointing the target on save. */}
              {!targetConnections.some((row) => row.id === target.connectionId) && (
                <option value={target.connectionId}>
                  {target.connection?.name ?? "unknown connection"}
                </option>
              )}
              {targetConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name} ({connection.type})
                </option>
              ))}
            </select>
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
          {targetConnections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name} ({connection.type})
            </option>
          ))}
        </select>
        <Button size="sm" onClick={addTarget} disabled={busy || !name.trim() || !connectionId}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>

      {connections.length === 0 && (
        <p className="text-xs text-amber-700">
          No connections yet. Create one under Data before running dbt.
        </p>
      )}

      <p className="text-xs text-gray-500">
        Lowercase letters, digits and underscores. Each target keeps its credential in its own
        environment variable, so two targets never authenticate with each other&apos;s password.
      </p>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  )
}
