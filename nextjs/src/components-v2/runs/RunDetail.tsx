"use client"

import React, { useMemo, useState } from "react"
import {
  AlertTriangle,
  Braces,
  CircleGauge,
  Clock3,
  Copy,
  Database,
  Download,
  GitCommit,
  Loader2,
  Search,
  Square,
  TerminalSquare,
  Timer,
} from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import {
  getDbtInvocationMetadata,
  getDbtNodeResults,
  timingDurationMs,
  type DbtNodeResult,
  type DbtTimingEntry,
} from "@/lib/dbt-run-logs"
import { cn } from "@/lib/utils"
import RunLogConsole, { downloadTextFile } from "./RunLogConsole"
import RunStatusBadge from "./RunStatusBadge"
import { formatDateTime, formatDuration, getFullCommand, shortHash } from "./formatters"
import type { DbtRun, DbtRunArtifact } from "./types"

type DetailTab = "overview" | "nodes" | "logs" | "artifact"

type NodeView = {
  uniqueId: string
  status: string
  executionTime: number | null
  threadId: string | null
  message: string | null
  error: string | null
  failures: number | null
  adapterResponse: Record<string, unknown> | null
  timing: DbtTimingEntry[]
  compiledCode: string | null
  relationName: string | null
}

function artifactTiming(value: unknown): DbtTimingEntry[] {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : []
}

function mergeNodeResult(node: DbtNodeResult, artifact?: DbtRunArtifact): NodeView {
  return {
    uniqueId: node.unique_id || artifact?.uniqueId || "unknown",
    status: node.status || artifact?.status || "unknown",
    executionTime: typeof node.execution_time === "number" ? node.execution_time : artifact?.executionTime ?? null,
    threadId: node.thread_id || null,
    message: node.message || null,
    error: artifact?.error || null,
    failures: typeof node.failures === "number" ? node.failures : null,
    adapterResponse: node.adapter_response && typeof node.adapter_response === "object" ? node.adapter_response : null,
    timing: Array.isArray(node.timing) ? node.timing : artifactTiming(artifact?.timing),
    compiledCode: node.compiled_code || artifact?.compiledCode || null,
    relationName: node.relation_name || null,
  }
}

function buildNodes(run: DbtRun): NodeView[] {
  const artifacts = run.artifacts || []
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.uniqueId, artifact]))
  const rawNodes = getDbtNodeResults(run.results)
  if (rawNodes.length > 0) {
    return rawNodes.map((node) => mergeNodeResult(node, artifactsById.get(node.unique_id || "")))
  }
  return artifacts.map((artifact) => mergeNodeResult({}, artifact))
}

function Metric({ icon: Icon, label, value, note }: { icon: React.ElementType; label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500"><Icon className="h-3.5 w-3.5" />{label}</div>
      <p className="mt-1 truncate text-sm font-semibold text-slate-900" title={value}>{value}</p>
      {note && <p className="mt-0.5 text-xs text-slate-400">{note}</p>}
    </div>
  )
}

function OverviewTab({ run, nodes }: { run: DbtRun; nodes: NodeView[] }) {
  const metadata = getDbtInvocationMetadata(run.results)
  const slowest = [...nodes]
    .filter((node) => node.executionTime != null)
    .sort((left, right) => (right.executionTime || 0) - (left.executionTime || 0))
    .slice(0, 5)
  const terminalNodes = nodes.filter((node) => ["success", "pass", "error", "fail", "warn", "skipped"].includes(node.status)).length

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={Clock3} label="Started" value={formatDateTime(run.startedAt)} />
        <Metric icon={Timer} label="Run duration" value={formatDuration(run.durationMs)} note={metadata.elapsedTime != null ? `dbt elapsed ${metadata.elapsedTime.toFixed(2)}s` : undefined} />
        <Metric icon={CircleGauge} label="Executed nodes" value={`${terminalNodes || run.modelsTotal || 0}`} note={`${run.modelsSuccess || 0} passed · ${run.modelsError || 0} failed`} />
        <Metric icon={GitCommit} label="Git commit" value={shortHash(run.gitCommit)} />
      </div>

      {run.errorMessage && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-800"><AlertTriangle className="h-4 w-4" />Failure summary</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-red-700">{run.errorMessage}</pre>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.7fr)]">
        <section>
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Invocation context</h3>
          <dl className="overflow-hidden rounded-lg border border-slate-200 text-sm">
            {[
              ["Run ID", run.id],
              ["Invocation ID", metadata.invocationId || "—"],
              ["dbt version", metadata.dbtVersion || "—"],
              ["Target", metadata.target || "—"],
              ["Threads", metadata.threads?.toString() || "—"],
              ["Generated at", formatDateTime(metadata.generatedAt)],
              ["Completed", formatDateTime(run.completedAt)],
              ["Schema", metadata.schemaVersion?.split("/").pop() || "—"],
            ].map(([label, value], index) => (
              <div key={label} className={cn("grid grid-cols-[8rem_minmax(0,1fr)] gap-3 px-3 py-2.5", index % 2 === 0 ? "bg-white" : "bg-slate-50/70")}>
                <dt className="text-slate-500">{label}</dt>
                <dd className="truncate font-mono text-xs text-slate-800" title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Slowest nodes</h3>
          <div className="overflow-hidden rounded-lg border border-slate-200">
            {slowest.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">No node timing was captured.</p>
            ) : slowest.map((node, index) => {
              const max = slowest[0].executionTime || 1
              const width = Math.max(4, ((node.executionTime || 0) / max) * 100)
              return (
                <div key={node.uniqueId} className={cn("p-3", index > 0 && "border-t border-slate-100")}>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-mono text-slate-700" title={node.uniqueId}>{node.uniqueId.split(".").pop()}</span>
                    <span className="shrink-0 tabular-nums font-semibold text-slate-600">{formatDuration((node.executionTime || 0) * 1000)}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-sky-500" style={{ width: `${width}%` }} /></div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

function NodeDetail({ node }: { node: NodeView }) {
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Relation</p>
          <p className="mt-1 break-all font-mono text-xs text-slate-700">{node.relationName || "—"}</p>
        </div>
        {(node.error || node.message) && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Adapter message</p>
            <pre className={cn("mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg p-3 font-mono text-xs", node.error ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700")}>
              {node.error || node.message}
            </pre>
          </div>
        )}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Timing phases</p>
          <div className="mt-1 space-y-1.5">
            {node.timing.length === 0 ? <p className="text-sm text-slate-400">No phase timing available.</p> : node.timing.map((timing, index) => (
              <div key={`${timing.name}-${index}`} className="flex items-center justify-between rounded-md bg-slate-100 px-3 py-2 text-xs">
                <span className="font-medium capitalize text-slate-700">{timing.name || `Phase ${index + 1}`}</span>
                <span className="font-mono text-slate-500">{formatDuration(timingDurationMs(timing))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Adapter response</p>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">{node.adapterResponse ? JSON.stringify(node.adapterResponse, null, 2) : "No adapter response"}</pre>
        </div>
        {node.compiledCode && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Compiled SQL</p>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre rounded-lg bg-slate-950 p-3 font-mono text-xs leading-5 text-emerald-300">{node.compiledCode}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

function NodesTab({ nodes }: { nodes: NodeView[] }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const statuses = Array.from(new Set(nodes.map((node) => node.status))).sort()
  const filtered = nodes.filter((node) => {
    const matchesStatus = status === "all" || node.status === status
    const matchesSearch = !query.trim() || node.uniqueId.toLowerCase().includes(query.trim().toLowerCase())
    return matchesStatus && matchesSearch
  })

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 pl-9" placeholder="Search model, test, seed…" />
        </div>
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500/20">
          <option value="all">All statuses</option>
          {statuses.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[760px]">
          <thead className="bg-slate-50 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <tr><th className="px-3 py-2.5">Resource</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Execution</th><th className="px-3 py-2.5">Thread</th><th className="px-3 py-2.5">Failures</th></tr>
          </thead>
          <tbody>
            {filtered.map((node) => (
              <React.Fragment key={node.uniqueId}>
                <tr className="border-t border-slate-100 bg-white hover:bg-slate-50">
                  <td className="px-3 py-3">
                    <button type="button" onClick={() => setExpandedId((current) => current === node.uniqueId ? null : node.uniqueId)} aria-expanded={expandedId === node.uniqueId} className="max-w-md text-left">
                      <span className="block font-mono text-sm font-medium text-slate-800">{node.uniqueId.split(".").pop()}</span>
                      <span className="block max-w-md truncate font-mono text-xs text-slate-400">{node.uniqueId}</span>
                    </button>
                  </td>
                  <td className="px-3 py-3"><RunStatusBadge status={node.status} /></td>
                  <td className="px-3 py-3 font-mono text-sm tabular-nums text-slate-600">{formatDuration(node.executionTime == null ? null : node.executionTime * 1000)}</td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-500">{node.threadId || "—"}</td>
                  <td className="px-3 py-3 text-sm tabular-nums text-slate-600">{node.failures ?? "—"}</td>
                </tr>
                {expandedId === node.uniqueId && (
                  <tr className="border-t border-slate-100 bg-slate-50/80"><td colSpan={5}><NodeDetail node={node} /></td></tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="p-8 text-center text-sm text-slate-500">No node results match these filters.</p>}
      </div>
    </div>
  )
}

export default function RunDetail({
  run,
  liveLogs,
  onCancel,
}: {
  run: DbtRun
  liveLogs: string[]
  onCancel: () => Promise<void>
}) {
  const [tab, setTab] = useState<DetailTab>("overview")
  const [cancelling, setCancelling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const nodes = useMemo(() => buildNodes(run), [run])
  const logs = liveLogs.length > 0 ? liveLogs.join("\n") : run.logs || ""
  const tabs: Array<{ id: DetailTab; label: string; icon: React.ElementType; count?: number }> = [
    { id: "overview", label: "Overview", icon: CircleGauge },
    { id: "nodes", label: "Node results", icon: Database, count: nodes.length },
    { id: "logs", label: "Logs", icon: TerminalSquare },
    { id: "artifact", label: "run_results.json", icon: Braces },
  ]

  const cancel = async () => {
    setCancelling(true)
    setActionError(null)
    try {
      await onCancel()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-sm font-medium text-slate-500">{run.project?.name || "Unknown project"}</span>
          </div>
          <code className="mt-2 block break-all font-mono text-base font-semibold text-slate-900">{getFullCommand(run)}</code>
          <p className="mt-1 font-mono text-xs text-slate-400">{run.id}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(run.id)}><Copy /> Copy ID</Button>
          {run.results != null && (
            <Button type="button" variant="outline" size="sm" onClick={() => downloadTextFile(`dbt-run-${run.id}-run_results.json`, JSON.stringify(run.results, null, 2), "application/json")}><Download /> Artifact</Button>
          )}
          {run.status === "running" && (
            <Button type="button" variant="destructive" size="sm" onClick={cancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="animate-spin" /> : <Square />} Cancel run
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">{actionError}</div>
      )}

      <div className="overflow-x-auto border-b border-slate-200 px-3" role="tablist" aria-label="Run detail sections">
        <div className="flex min-w-max">
          {tabs.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn("flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors", tab === id ? "border-sky-600 text-sky-700" : "border-transparent text-slate-500 hover:text-slate-800")}
            >
              <Icon className="h-4 w-4" />{label}{count != null && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-500">{count}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 sm:p-5">
        {tab === "overview" && <OverviewTab run={run} nodes={nodes} />}
        {tab === "nodes" && <NodesTab nodes={nodes} />}
        {tab === "logs" && <RunLogConsole logs={logs} runId={run.id} running={run.status === "running"} />}
        {tab === "artifact" && (
          run.results == null ? (
            <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-slate-300 text-center text-sm text-slate-500">No run_results.json artifact was captured for this command.</div>
          ) : (
            <pre className="max-h-[42rem] overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-300">{JSON.stringify(run.results, null, 2)}</pre>
          )
        )}
      </div>
    </div>
  )
}
