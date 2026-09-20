"use client"

import React, { useCallback, useEffect, useState } from "react"
import { CalendarClock, Loader2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import {
  createSchedule,
  deleteSchedule,
  getSchedules,
  updateSchedule,
  type ScheduleRow,
} from "@/lib/api-client"

interface Props {
  sourceId: string
  projectId: string
  loadName: string
}

/** Cron presets, in UTC, for the intervals people actually ask for. */
const PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 03:00 UTC", cron: "0 3 * * *" },
  { label: "Every Monday at 03:00 UTC", cron: "0 3 * * 1" },
]

/**
 * When this load runs by itself, and who hears about it when it fails.
 *
 * Before this, nothing ever fired an ingest load: `dbt_schedules` ran dbt only,
 * so freshness depended on a person pressing Run. A load nobody runs is a
 * dashboard that quietly shows last month.
 */
export default function LoadScheduleCard({
  sourceId,
  projectId,
  loadName,
}: Props): React.ReactElement {
  const [schedule, setSchedule] = useState<ScheduleRow | null>(null)
  const [cron, setCron] = useState(PRESETS[1].cron)
  const [webhookUrl, setWebhookUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await getSchedules(projectId)
      const mine = (Array.isArray(rows) ? rows : []).find(
        (row) => row.ingestSourceId === sourceId,
      )
      setSchedule(mine ?? null)
      if (mine) {
        setCron(mine.cron)
        setWebhookUrl(mine.webhookUrl ?? "")
      }
    } catch {
      // A missing schedule list must not break the page it sits on.
      setSchedule(null)
    }
  }, [projectId, sourceId])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const payload = {
        projectId,
        name: `${loadName} schedule`,
        cron: cron.trim(),
        ingestSourceId: sourceId,
        webhookUrl: webhookUrl.trim() || null,
        isActive: true,
      }
      if (schedule) await updateSchedule(schedule.id, payload)
      else await createSchedule(payload)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the schedule")
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!schedule) return
    setBusy(true)
    setError(null)
    try {
      await deleteSchedule(schedule.id)
      setSchedule(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the schedule")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-medium text-slate-900">
            <CalendarClock className="h-4 w-4 text-slate-400" /> Runs by itself
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {schedule
              ? `${schedule.cron} (UTC)${
                  schedule.nextRunAt
                    ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}`
                    : " · arming on the next tick"
                }`
              : "Only when you press Run."}
          </p>
        </div>
        {schedule && (
          <Button variant="outline" size="sm" disabled={busy} onClick={remove}>
            Stop scheduling
          </Button>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">How often</span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={PRESETS.some((preset) => preset.cron === cron) ? cron : "custom"}
            onChange={(event) => {
              if (event.target.value !== "custom") setCron(event.target.value)
            }}
          >
            {PRESETS.map((preset) => (
              <option key={preset.cron} value={preset.cron}>
                {preset.label}
              </option>
            ))}
            <option value="custom">Custom cron…</option>
          </select>
          <Input
            className="mt-2 font-mono text-xs"
            value={cron}
            aria-label="Cron expression, UTC"
            onChange={(event) => setCron(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Tell me when it fails</span>
          <Input
            value={webhookUrl}
            placeholder="https://hooks.slack.com/services/…"
            onChange={(event) => setWebhookUrl(event.target.value)}
          />
          <span className="mt-1 block text-xs text-slate-500">
            Slack, Teams and Discord incoming webhooks all accept it. Only failures are sent.
          </span>
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-4">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {schedule ? "Save schedule" : "Run on a schedule"}
        </Button>
      </div>
    </div>
  )
}
