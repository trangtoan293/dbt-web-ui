"use client"

import React from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import { generateUUID } from "@/lib/api/client"
import type { DbtEnvironmentVariable, DbtEnvironmentVariableType } from "./types"

export const createEnvironmentVariable = (): DbtEnvironmentVariable => ({
  id: generateUUID(),
  name: "",
  value: "",
  type: "text",
})

interface EnvVarsPanelProps {
  value: DbtEnvironmentVariable[]
  onChange: (next: DbtEnvironmentVariable[]) => void
  onSave: () => void
  saving: boolean
  error: string | null
}

/** Editor for the project's dbt environment variables. */
export default function EnvVarsPanel({
  value,
  onChange,
  onSave,
  saving,
  error,
}: EnvVarsPanelProps): React.ReactElement {
  const update = (id: string, patch: Partial<DbtEnvironmentVariable>) =>
    onChange(value.map((item) => (item.id === id ? { ...item, ...patch } : item)))

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500">
        Passed to every dbt command in this project. Values are stored encrypted on the server and
        never returned to the browser.
      </p>

      <div>
        <div className="grid grid-cols-[1fr_1fr_120px_40px] gap-2 text-xs font-medium uppercase text-gray-500">
          <span>Name</span>
          <span>Value</span>
          <span>Type</span>
          <span />
        </div>
        <div className="mt-2 space-y-2">
          {value.length === 0 ? (
            <div className="rounded-md border border-dashed border-gray-300 px-3 py-6 text-center text-sm text-gray-500">
              No environment variables configured.
            </div>
          ) : (
            value.map((item) => (
              <div key={item.id} className="grid grid-cols-[1fr_1fr_120px_40px] gap-2">
                <Input
                  value={item.name}
                  onChange={(event) => update(item.id, { name: event.target.value })}
                  placeholder="DBT_ENV_SECRET_TOKEN"
                  aria-label="Variable name"
                  className="font-mono text-xs"
                />
                <Input
                  value={item.value}
                  type={item.type === "password" ? "password" : "text"}
                  onChange={(event) => update(item.id, { value: event.target.value })}
                  placeholder={
                    item.hasValue ? "Saved value unchanged" : item.type === "password" ? "secret value" : "value"
                  }
                  aria-label="Variable value"
                  className="font-mono text-xs"
                />
                <select
                  value={item.type}
                  onChange={(event) =>
                    update(item.id, { type: event.target.value as DbtEnvironmentVariableType })
                  }
                  aria-label="Variable type"
                  className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0078D4]"
                >
                  <option value="text">Text</option>
                  <option value="password">Password</option>
                </select>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((env) => env.id !== item.id))}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"
                  title="Remove variable"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={() => onChange([...value, createEnvironmentVariable()])}>
          <Plus className="h-4 w-4" />
          Add variable
        </Button>
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save variables"}
        </Button>
      </div>
    </div>
  )
}
