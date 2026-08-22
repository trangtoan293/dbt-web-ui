"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, CalendarClock, Check, Loader2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components-v2/ui/dialog"
import { dbtApi } from "@/lib/api"
import {
  createSchedule,
  getProjectTargets,
  updateSchedule,
  type RunCommandName,
  type ScheduleRow,
} from "@/lib/api-client"

const COMMANDS: { value: RunCommandName; label: string }[] = [
  { value: "run", label: "dbt run" },
  { value: "build", label: "dbt build" },
  { value: "test", label: "dbt test" },
  { value: "seed", label: "dbt seed" },
  { value: "snapshot", label: "dbt snapshot" },
  { value: "source_freshness", label: "dbt source freshness" },
  { value: "compile", label: "dbt compile" },
  { value: "docs", label: "dbt docs generate" },
  { value: "deps", label: "dbt deps" },
]

const PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 02:00", cron: "0 2 * * *" },
  { label: "Weekdays 06:00", cron: "0 6 * * 1-5" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
]

interface Project {
  id: string
  name: string
}

interface ScheduleDialogProps {
  open: boolean
  existing: ScheduleRow | null
  projects: Project[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}

const EMPTY = {
  projectId: "",
  name: "",
  command: "run" as RunCommandName,
  selector: "",
  target: "",
  cron: "0 2 * * *",
  isActive: true,
  webhookUrl: "",
  publishSchema: "",
}

export default function ScheduleDialog({
  open,
  existing,
  projects,
  onClose,
  onSaved,
}: ScheduleDialogProps): React.ReactElement {
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [targets, setTargets] = useState<string[]>([])
  const [preview, setPreview] = useState<{ valid: boolean; message: string | null; next: string[] }>(
    { valid: true, message: null, next: [] },
  )

  useEffect(() => {
    if (!open) return
    setError(null)
    setForm(
      existing
        ? {
            projectId: existing.projectId,
            name: existing.name,
            command: existing.command,
            selector: existing.selector ?? "",
            target: existing.target ?? "",
            cron: existing.cron,
            isActive: existing.isActive,
            webhookUrl: existing.webhookUrl ?? "",
            publishSchema: existing.publishSchema ?? "",
          }
        : { ...EMPTY, projectId: projects[0]?.id ?? "" },
    )
  }, [existing, open, projects])

  // The runner is the authority on cron parsing, so ask it rather than
  // re-implementing croniter in the browser.
  useEffect(() => {
    if (!open || !form.cron.trim()) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const result = await dbtApi.previewCron(form.cron, 3)
        if (!cancelled) {
          setPreview({
            valid: result.valid,
            message: result.message,
            next: result.next_runs ?? [],
          })
        }
      } catch {
        if (!cancelled) setPreview({ valid: true, message: null, next: [] })
      }
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [form.cron, open])

  useEffect(() => {
    if (!open || !form.projectId) {
      setTargets([])
      return
    }
    getProjectTargets(form.projectId)
      .then((rows) => setTargets(rows.map((row) => row.name)))
      .catch(() => setTargets([]))
  }, [form.projectId, open])

  const setField = useCallback(
    <K extends keyof typeof EMPTY>(key: K) =>
      (value: (typeof EMPTY)[K]) =>
        setForm((current) => ({ ...current, [key]: value })),
    [],
  )

  const canSave = useMemo(
    () => Boolean(form.projectId && form.name.trim() && form.cron.trim() && preview.valid),
    [form.cron, form.name, form.projectId, preview.valid],
  )

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const payload = {
        projectId: form.projectId,
        name: form.name.trim(),
        command: form.command,
        selector: form.selector.trim() || null,
        target: form.target.trim() || null,
        cron: form.cron.trim(),
        isActive: form.isActive,
        webhookUrl: form.webhookUrl.trim() || null,
        publishSchema: form.publishSchema.trim() || null,
      }
      if (existing) {
        await updateSchedule(existing.id, payload)
      } else {
        await createSchedule(payload)
      }
      await onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save schedule")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            Runs a dbt command on a cron. Times are UTC.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Project</label>
            <select
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
              value={form.projectId}
              onChange={(event) => setField("projectId")(event.target.value)}
              disabled={Boolean(existing)}
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
            <Input
              value={form.name}
              onChange={(event) => setField("name")(event.target.value)}
              placeholder="Nightly build"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Command</label>
              <select
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                value={form.command}
                onChange={(event) => setField("command")(event.target.value as RunCommandName)}
              >
                {COMMANDS.map((command) => (
                  <option key={command.value} value={command.value}>
                    {command.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Target <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <select
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                value={form.target}
                onChange={(event) => setField("target")(event.target.value)}
              >
                <option value="">Project default (dev)</option>
                {targets.map((target) => (
                  <option key={target} value={target}>
                    {target}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Selector <span className="font-normal text-gray-400">(--select, optional)</span>
            </label>
            <Input
              value={form.selector}
              onChange={(event) => setField("selector")(event.target.value)}
              placeholder="tag:daily+"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Cron (UTC)</label>
            <Input
              value={form.cron}
              onChange={(event) => setField("cron")(event.target.value)}
              placeholder="0 2 * * *"
              className="font-mono"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              {PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => setField("cron")(preset.cron)}
                  className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:border-[#0078D4] hover:text-[#0078D4]"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {preview.valid ? (
              preview.next.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
                  <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Next: {preview.next.map((iso) => new Date(iso).toUTCString()).join(" · ")}
                  </span>
                </p>
              )
            ) : (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{preview.message ?? "Invalid cron expression"}</span>
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Failure webhook <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <Input
              value={form.webhookUrl}
              onChange={(event) => setField("webhookUrl")(event.target.value)}
              placeholder="https://hooks.slack.com/services/..."
            />
            <p className="mt-1 text-xs text-gray-500">
              POSTed a JSON summary when a run of this schedule does not succeed. Slack, Teams and
              Discord incoming webhooks all accept it.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Publish to Iceberg <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <Input
              value={form.publishSchema}
              onChange={(event) => setField("publishSchema")(event.target.value)}
              placeholder="marts"
            />
            <p className="mt-1 text-xs text-gray-500">
              After a successful run, copy this lake schema out as Iceberg tables, so engines
              that cannot read DuckLake see the fresh marts. A run that only appended publishes
              just the new files; a rebuilt table is replaced.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => setField("isActive")(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Active
          </label>

          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !canSave}>
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" /> {existing ? "Save changes" : "Create schedule"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
