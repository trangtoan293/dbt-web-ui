"use client"

import React, { useEffect, useState } from "react"
import { AlertCircle, Check, Copy, Loader2, ShieldCheck } from "lucide-react"
import { useGlobal } from "@/lib/context/GlobalContext"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components-v2/ui/card"
import PageHeader from "@/components-v2/layout/PageHeader"
import { getSystemInfo, type SystemInfo } from "@/lib/api-client"

function formatSeconds(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 360) / 10} h`
  if (seconds >= 60) return `${Math.round(seconds / 6) / 10} min`
  return `${seconds} s`
}

function formatDays(days: number, zeroLabel: string): string {
  return days === 0 ? zeroLabel : `${days} days`
}

interface FactProps {
  label: string
  value: string
  note?: string
  tone?: "default" | "warn"
}

function Fact({ label, value, note, tone = "default" }: FactProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5 border-b border-gray-100 py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <span className="text-sm text-gray-600">{label}</span>
      <span className="flex flex-wrap items-baseline gap-2 sm:justify-end">
        <span className={tone === "warn" ? "text-sm font-medium text-amber-700" : "text-sm font-medium text-gray-900"}>
          {value}
        </span>
        {note && <span className="text-xs text-gray-400">{note}</span>}
      </span>
    </div>
  )
}

function CopyableId({ value }: { value: string }): React.ReactElement {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy user ID"}
    </button>
  )
}

export default function SettingsPage(): React.ReactElement {
  const { user } = useGlobal()
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [systemError, setSystemError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getSystemInfo()
      .then((info) => {
        if (!cancelled) setSystem(info)
      })
      .catch((error: unknown) => {
        if (!cancelled) setSystemError(error instanceof Error ? error.message : "Failed to load system info")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeader title="Settings" description="Your account, and how this deployment is configured" />

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Signed in through your identity provider</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm text-gray-600">Email</span>
            <span className="text-sm font-medium text-gray-900">{user?.email || "—"}</span>
          </div>
          <div className="flex gap-3 rounded-lg border border-blue-100 bg-blue-50/70 p-4 text-sm text-blue-900">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0078D4]" />
            <p className="leading-5">
              Password and sign-in settings are controlled by your identity provider, not by this app.
            </p>
          </div>
          {user?.id && <CopyableId value={user.id} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System</CardTitle>
          <CardDescription>
            Read-only. These come from the deployment&apos;s environment and change only on a restart.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading deployment settings…
            </div>
          )}

          {!loading && systemError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{systemError}</span>
            </div>
          )}

          {!loading && system && (
            <div className="space-y-5">
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Runs</h3>
                <Fact
                  label="Concurrent runs"
                  value={`${system.runs.max_concurrent} across the workspace`}
                  note={`${system.runs.per_project_concurrent} per project`}
                />
                <Fact
                  label="Run history kept"
                  value={formatDays(system.runs.history_retention_days, "Forever")}
                  note="older runs are pruned"
                />
                <Fact label="Run timeout" value={formatSeconds(system.runs.subprocess_timeout_seconds)} />
                <Fact
                  label="Warm workers"
                  value={system.worker.warm_pool_enabled ? `On · ${system.worker.warm_pool_size}` : "Off"}
                />
              </section>

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Scheduler</h3>
                <Fact
                  label="Status"
                  value={
                    !system.scheduler.enabled
                      ? "Disabled"
                      : system.scheduler.running
                        ? "Running"
                        : "Enabled, not running"
                  }
                  tone={system.scheduler.enabled && !system.scheduler.running ? "warn" : "default"}
                />
                {system.scheduler.enabled && (
                  <Fact
                    label="Leader election"
                    value={system.scheduler.leader ? "This worker is leader" : "Another worker is leader"}
                    note={`checks every ${system.scheduler.tick_seconds}s`}
                  />
                )}
                <Fact
                  label="Skip runs overdue by"
                  value={formatSeconds(system.scheduler.misfire_grace_seconds)}
                  note="after an outage"
                />
              </section>

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Lakehouse &amp; ingest</h3>
                <Fact
                  label="Lakehouse"
                  value={system.lakehouse.configured ? "Configured" : "Not configured"}
                  tone={system.lakehouse.configured ? "default" : "warn"}
                />
                <Fact
                  label="Snapshots kept"
                  value={formatDays(system.lakehouse.snapshot_retention_days, "Forever")}
                  note={`maintenance every ${system.lakehouse.maintenance_interval_hours}h`}
                />
                <Fact
                  label="Private hosts as ingest source"
                  value={system.ingest.allow_private_hosts ? "Allowed" : "Blocked"}
                  note={system.ingest.allow_private_hosts ? "on-premise warehouses reachable" : "on-premise warehouses refused"}
                />
                <Fact label="Ingest timeout" value={formatSeconds(system.ingest.subprocess_timeout_seconds)} />
              </section>

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Deployment</h3>
                <Fact
                  label="Authentication"
                  value={system.auth.mode === "disabled" ? "Disabled (single local user)" : "OIDC"}
                  tone={system.auth.mode === "disabled" ? "warn" : "default"}
                />
                <Fact label="Warehouse adapters" value={system.adapters.join(", ")} />
                <Fact label="Version" value={system.version} />
              </section>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
