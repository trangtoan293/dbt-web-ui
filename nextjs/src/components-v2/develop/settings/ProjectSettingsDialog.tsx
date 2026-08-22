"use client"

import React, { useEffect, useState } from "react"
import { AlertTriangle, Database, KeyRound, Layers, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components-v2/ui/dialog"
import ConnectionCheckDialog from "@/components-v2/develop/ConnectionCheckDialog"
import type { Connection } from "@/components-v2/develop/types"
import { cn } from "@/lib/utils"
import EnvVarsPanel from "./EnvVarsPanel"
import TargetsPanel from "./TargetsPanel"
import type { DbtEnvironmentVariable, ProjectSettingsTab } from "./types"

interface ProjectSummary {
  id: string
  name: string
  description: string | null
  git_url: string | null
  git_branch: string
  connection_id: string | null
  dremio_source_id: string | null
  deleted_at?: string | null
}

interface ProjectSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab: ProjectSettingsTab
  project: ProjectSummary
  worktreeLabel: string
  connections: Connection[]
  busy: boolean
  onSelectConnection: (connectionId: string) => void
  onRename: (name: string) => void
  onTargetsChanged: () => void
  environmentVariables: DbtEnvironmentVariable[]
  onEnvironmentVariablesChange: (next: DbtEnvironmentVariable[]) => void
  onSaveEnvironmentVariables: () => void
  envVarsSaving: boolean
  envVarsError: string | null
  onDeleteProject: () => void
  onRestoreProject: () => void
  onHardDeleteProject: () => void
}

const TABS: { id: ProjectSettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "environments", label: "Environments", icon: Layers },
  { id: "variables", label: "Variables", icon: KeyRound },
  { id: "danger", label: "Danger zone", icon: AlertTriangle },
]

function ReadOnlyRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 py-1.5 text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="truncate font-mono text-gray-800" title={value}>
        {value}
      </span>
    </div>
  )
}

/**
 * One place for everything configured on a single project.
 *
 * These settings used to be reached from seven different controls across the
 * IDE - the toolbar, the project menu and the right rail - so nothing showed a
 * project's configuration as a whole.
 */
export default function ProjectSettingsDialog({
  open,
  onOpenChange,
  initialTab,
  project,
  worktreeLabel,
  connections,
  busy,
  onSelectConnection,
  onRename,
  onTargetsChanged,
  environmentVariables,
  onEnvironmentVariablesChange,
  onSaveEnvironmentVariables,
  envVarsSaving,
  envVarsError,
  onDeleteProject,
  onRestoreProject,
  onHardDeleteProject,
}: ProjectSettingsDialogProps): React.ReactElement {
  const [tab, setTab] = useState<ProjectSettingsTab>(initialTab)
  const [name, setName] = useState(project.name)

  // Reopening from a different control must land on that control's tab. Keyed
  // on the tab alone: a rename lands in project.name and must not bounce the
  // user back to whichever tab they entered from.
  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  // Drop an abandoned rename draft, and pick up a name changed elsewhere.
  useEffect(() => {
    if (open) setName(project.name)
  }, [open, project.name])

  const activeConnectionId = project.connection_id || project.dremio_source_id || ""
  const nameChanged = name.trim().length > 0 && name.trim() !== project.name

  // A confirmation on top of this dialog would stack two overlays, so hand off.
  const handOff = (action: () => void) => {
    onOpenChange(false)
    action()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-gray-200 px-5 py-4">
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription className="truncate">{project.name}</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[70vh] grid-cols-1 sm:grid-cols-[180px_minmax(0,1fr)]">
          <nav
            aria-label="Project settings sections"
            className="flex gap-1 overflow-x-auto border-b border-gray-200 p-2 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r"
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]",
                  tab === item.id
                    ? "bg-[#0078D4]/10 font-medium text-[#0078D4]"
                    : "text-gray-600 hover:bg-gray-100",
                  item.id === "danger" && tab !== item.id && "text-red-600 hover:bg-red-50"
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 overflow-y-auto p-5">
            {tab === "general" && (
              <div className="space-y-6">
                <section className="space-y-2">
                  <label htmlFor="project-name" className="text-sm font-medium text-gray-800">
                    Name
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="project-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={busy || Boolean(project.deleted_at)}
                    />
                    <Button onClick={() => onRename(name.trim())} disabled={!nameChanged || busy}>
                      {busy ? "Saving…" : "Rename"}
                    </Button>
                  </div>
                  {project.description && <p className="text-xs text-gray-500">{project.description}</p>}
                </section>

                <section className="space-y-2">
                  <label htmlFor="project-connection" className="text-sm font-medium text-gray-800">
                    Connection
                  </label>
                  <p className="text-xs text-gray-500">
                    The warehouse every dbt command runs against. This is target{" "}
                    <code className="rounded bg-gray-100 px-1 py-0.5">dev</code>.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      id="project-connection"
                      value={activeConnectionId}
                      onChange={(event) => onSelectConnection(event.target.value)}
                      disabled={busy || Boolean(project.deleted_at)}
                      className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm disabled:opacity-50"
                    >
                      <option value="">None — dbt commands will not run</option>
                      {connections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.name} ({connection.type})
                        </option>
                      ))}
                    </select>
                    <ConnectionCheckDialog projectId={project.id} />
                  </div>
                  {connections.length === 0 && (
                    <p className="text-xs text-amber-700">
                      No connections yet. Create one under Data before running dbt.
                    </p>
                  )}
                </section>

                <section>
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium text-gray-800">
                    <Database className="h-4 w-4 text-gray-400" />
                    Repository
                  </h3>
                  <div className="rounded-md border border-gray-200 px-3 py-1.5">
                    <ReadOnlyRow label="Branch" value={project.git_branch || "main"} />
                    <ReadOnlyRow label="Remote" value={project.git_url || "no remote"} />
                    <ReadOnlyRow label="Worktree" value={worktreeLabel} />
                    <ReadOnlyRow label="Project ID" value={project.id} />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    Git credentials are asked for the first time a push or pull needs them, and stored
                    encrypted per project.
                  </p>
                </section>
              </div>
            )}

            {tab === "environments" && <TargetsPanel projectId={project.id} onChanged={onTargetsChanged} />}

            {tab === "variables" && (
              <EnvVarsPanel
                value={environmentVariables}
                onChange={onEnvironmentVariablesChange}
                onSave={onSaveEnvironmentVariables}
                saving={envVarsSaving}
                error={envVarsError}
              />
            )}

            {tab === "danger" && (
              <div className="space-y-4">
                {project.deleted_at ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-emerald-900">Restore project</p>
                        <p className="text-xs text-emerald-800/80">
                          Brings the project back with its files and history intact.
                        </p>
                      </div>
                      <Button variant="outline" onClick={() => handOff(onRestoreProject)} disabled={busy}>
                        <RotateCcw className="h-4 w-4" />
                        Restore
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-red-900">Delete permanently</p>
                        <p className="text-xs text-red-800/80">
                          Removes the project, its files and its run history. Cannot be undone.
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => handOff(onHardDeleteProject)}
                        disabled={busy}
                        className="border-red-300 text-red-700 hover:bg-red-100"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete permanently
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-red-900">Delete project</p>
                      <p className="text-xs text-red-800/80">
                        Moves the project out of the workspace. You can restore it, or delete it for good.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => handOff(onDeleteProject)}
                      disabled={busy}
                      className="border-red-300 text-red-700 hover:bg-red-100"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
