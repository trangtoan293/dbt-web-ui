"use client"

import React, { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Card, CardContent } from "@/components-v2/ui/card"
import EmptyState from "@/components-v2/shared/EmptyState"
import ScheduleDialog from "@/components-v2/schedules/ScheduleDialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components-v2/ui/alert-dialog"
import { dbtApi } from "@/lib/api"
import {
  deleteSchedule,
  getProjects,
  getSchedules,
  updateSchedule,
  type ScheduleRow,
} from "@/lib/api-client"
import { cn } from "@/lib/utils"

interface Project {
  id: string
  name: string
}

const COMMAND_LABELS: Record<string, string> = {
  run: "dbt run",
  build: "dbt build",
  test: "dbt test",
  seed: "dbt seed",
  snapshot: "dbt snapshot",
  source_freshness: "dbt source freshness",
  compile: "dbt compile",
  docs: "dbt docs generate",
  deps: "dbt deps",
  clean: "dbt clean",
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString(undefined, { timeZone: "UTC", hour12: false }) + " UTC"
}

function StatusPill({ status }: { status: string | null }): React.ReactElement | null {
  if (!status) return null
  const tone =
    status === "success"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
      : status === "running"
        ? "bg-sky-50 text-sky-700 ring-sky-100"
        : status === "error"
          ? "bg-red-50 text-red-700 ring-red-100"
          : "bg-slate-50 text-slate-600 ring-slate-100"
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium ring-1", tone)}>{status}</span>
  )
}

export default function SchedulesView(): React.ReactElement {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduleRow | null>(null)
  const [toDelete, setToDelete] = useState<ScheduleRow | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [scheduleRows, projectRows] = await Promise.all([getSchedules(), getProjects()])
      setSchedules(Array.isArray(scheduleRows) ? scheduleRows : [])
      setProjects(
        (Array.isArray(projectRows) ? projectRows : []).map((project) => ({
          id: project.id,
          name: project.name,
        })),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function toggleActive(schedule: ScheduleRow) {
    setBusyId(schedule.id)
    setError(null)
    try {
      await updateSchedule(schedule.id, {
        projectId: schedule.projectId,
        name: schedule.name,
        command: schedule.command,
        selector: schedule.selector,
        target: schedule.target,
        cron: schedule.cron,
        webhookUrl: schedule.webhookUrl,
        isActive: !schedule.isActive,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule")
    } finally {
      setBusyId(null)
    }
  }

  /** Start the schedule's command now, without touching its cron timing. */
  async function runNow(schedule: ScheduleRow) {
    setBusyId(schedule.id)
    setError(null)
    setNotice(null)
    try {
      const command =
        schedule.command === "source_freshness" ? "source freshness" : schedule.command
      await dbtApi.startRun({
        project_id: schedule.projectId,
        command,
        selector: schedule.selector ?? undefined,
        target: schedule.target ?? undefined,
      })
      setNotice(`Started ${schedule.name}. Follow it in History.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run")
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete() {
    if (!toDelete) return
    setBusyId(toDelete.id)
    try {
      await deleteSchedule(toDelete.id)
      setToDelete(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">Cron is evaluated in UTC.</p>
        <Button
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
          disabled={projects.length === 0}
        >
          <Plus className="mr-2 h-4 w-4" /> New schedule
        </Button>
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 className="h-4 w-4" /> {notice}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No schedules yet"
          description={
            projects.length === 0
              ? "Create a project first — a schedule runs one project's dbt command."
              : "A schedule runs a dbt command on a cron and can POST a webhook when a run fails."
          }
          action={
            projects.length > 0 ? (
              <Button
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <Plus className="mr-2 h-4 w-4" /> New schedule
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => (
            <Card key={schedule.id} className={schedule.isActive ? undefined : "opacity-70"}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-gray-900">{schedule.name}</p>
                      <StatusPill status={schedule.lastStatus} />
                      {!schedule.isActive && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                          paused
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {schedule.project?.name ?? "project"} ·{" "}
                      {COMMAND_LABELS[schedule.command] ?? schedule.command}
                      {schedule.selector ? ` --select ${schedule.selector}` : ""}
                      {schedule.target ? ` --target ${schedule.target}` : ""}
                    </p>
                    <p className="mt-1 font-mono text-xs text-slate-500">{schedule.cron}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      title="Run now"
                      disabled={busyId === schedule.id}
                      onClick={() => runNow(schedule)}
                    >
                      <Play className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title={schedule.isActive ? "Pause" : "Resume"}
                      disabled={busyId === schedule.id}
                      onClick={() => toggleActive(schedule)}
                    >
                      {schedule.isActive ? (
                        <Pause className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title="Edit"
                      onClick={() => {
                        setEditing(schedule)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      title="Delete"
                      onClick={() => setToDelete(schedule)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500 sm:grid-cols-3">
                  <p>
                    <span className="text-slate-400">Next run </span>
                    {schedule.isActive ? formatWhen(schedule.nextRunAt) : "paused"}
                  </p>
                  <p>
                    <span className="text-slate-400">Last run </span>
                    {formatWhen(schedule.lastRunAt)}
                  </p>
                  <p className="truncate">
                    <span className="text-slate-400">Webhook </span>
                    {schedule.webhookUrl ? "configured" : "none"}
                  </p>
                </div>

                {schedule.isActive && !schedule.nextRunAt && (
                  <p className="flex items-start gap-1.5 text-xs text-slate-500">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                    Waiting to be armed by the runner. A new schedule does not fire the moment it is
                    saved — its first run is the next matching cron slot after the runner picks it up.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog
        open={!!toDelete}
        onOpenChange={(open) => {
          if (!open) setToDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              “{toDelete?.name}” stops running. Runs it already produced stay in History.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                handleDelete()
              }}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              Delete schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ScheduleDialog
        open={dialogOpen}
        existing={editing}
        projects={projects}
        onClose={() => setDialogOpen(false)}
        onSaved={load}
      />
    </div>
  )
}
