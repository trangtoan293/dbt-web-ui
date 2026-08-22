"use client"

import React, { useCallback, useEffect, useState } from "react"
import { Layers } from "lucide-react"
import { getProjectTargets, type ProjectTargetRow } from "@/lib/api-client"

/** The project's own connection. Always present, never a project_targets row. */
export const DEFAULT_DBT_TARGET = "dev"

interface TargetSelectorProps {
  projectId: string
  value: string
  onChange: (target: string) => void
  /** Opens Project settings on the Environments tab, where targets are managed. */
  onManage: () => void
  /** Bumped after the settings dialog changes the target list. */
  reloadKey?: number
}

/**
 * Chooses which profiles.yml output dbt commands run against.
 *
 * Picking a target is a property of the next run, so it stays on the toolbar;
 * the list of targets is project configuration and lives in Project settings.
 */
export default function TargetSelector({
  projectId,
  value,
  onChange,
  onManage,
  reloadKey = 0,
}: TargetSelectorProps): React.ReactElement {
  const [targets, setTargets] = useState<ProjectTargetRow[]>([])

  const load = useCallback(async () => {
    try {
      setTargets(await getProjectTargets(projectId))
    } catch {
      setTargets([])
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  // A target that no longer exists must not stay selected, or every command
  // gets a --target dbt will reject.
  useEffect(() => {
    if (value === DEFAULT_DBT_TARGET) return
    if (!targets.some((target) => target.name === value)) onChange(DEFAULT_DBT_TARGET)
  }, [onChange, targets, value])

  return (
    <div className="flex items-center gap-1.5">
      <span title="dbt target">
        <Layers className="h-4 w-4 text-[#616161]" />
      </span>
      <select
        value={value}
        onChange={(event) => {
          if (event.target.value === "__manage__") {
            onManage()
            return
          }
          onChange(event.target.value)
        }}
        className="h-8 rounded border border-[#E6E6E6] bg-white px-2 text-xs text-[#242424]"
        title="Target every dbt command in this project runs against"
      >
        <option value={DEFAULT_DBT_TARGET}>dev (project connection)</option>
        {targets.map((target) => (
          <option key={target.id} value={target.name}>
            {target.name}
            {target.connection ? ` (${target.connection.name})` : ""}
          </option>
        ))}
        <option value="__manage__">Manage targets…</option>
      </select>
    </div>
  )
}
