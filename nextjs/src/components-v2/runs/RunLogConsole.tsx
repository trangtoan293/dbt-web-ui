"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsDown, Copy, Download, Search, WrapText } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import {
  filterDbtLogEntries,
  parseDbtLogs,
  type DbtLogLevel,
} from "@/lib/dbt-run-logs"
import { cn } from "@/lib/utils"

const LOG_LEVELS: DbtLogLevel[] = ["error", "warn", "success", "info", "debug", "unknown"]
const MAX_RENDERED_LINES = 2000

const LEVEL_STYLES: Record<DbtLogLevel, string> = {
  error: "text-red-300",
  warn: "text-amber-300",
  success: "text-emerald-300",
  info: "text-sky-300",
  debug: "text-violet-300",
  unknown: "text-slate-400",
}

const LEVEL_BUTTON_STYLES: Record<DbtLogLevel, string> = {
  error: "border-red-300 bg-red-50 text-red-700",
  warn: "border-amber-300 bg-amber-50 text-amber-700",
  success: "border-emerald-300 bg-emerald-50 text-emerald-700",
  info: "border-sky-300 bg-sky-50 text-sky-700",
  debug: "border-violet-300 bg-violet-50 text-violet-700",
  unknown: "border-slate-300 bg-slate-50 text-slate-600",
}

export function downloadTextFile(filename: string, value: string, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([value], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function displayTimestamp(value: string | null): string {
  if (!value) return ""
  if (!value.includes("T")) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 })
}

export default function RunLogConsole({
  logs,
  runId,
  running,
}: {
  logs: string
  runId: string
  running: boolean
}) {
  const [query, setQuery] = useState("")
  const [enabledLevels, setEnabledLevels] = useState<Set<DbtLogLevel>>(() => new Set(LOG_LEVELS))
  const [wrap, setWrap] = useState(true)
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(() => parseDbtLogs(logs), [logs])
  const filteredEntries = useMemo(
    () => filterDbtLogEntries(entries, query, enabledLevels),
    [enabledLevels, entries, query],
  )
  const visibleEntries = useMemo(() => {
    if (filteredEntries.length <= MAX_RENDERED_LINES) return filteredEntries
    return follow
      ? filteredEntries.slice(-MAX_RENDERED_LINES)
      : filteredEntries.slice(0, MAX_RENDERED_LINES)
  }, [filteredEntries, follow])
  const levelCounts = useMemo(() => {
    const counts: Record<DbtLogLevel, number> = {
      error: 0,
      warn: 0,
      success: 0,
      info: 0,
      debug: 0,
      unknown: 0,
    }
    for (const entry of entries) counts[entry.level] += 1
    return counts
  }, [entries])

  useEffect(() => {
    if (follow && viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight
    }
  }, [follow, visibleEntries.length])

  const toggleLevel = (level: DbtLogLevel) => {
    setEnabledLevels((current) => {
      const next = new Set(current)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  const copyLogs = async () => {
    await navigator.clipboard.writeText(logs)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-inner">
      <div className="space-y-3 border-b border-slate-800 bg-slate-900/90 p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative min-w-0 flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search message, thread, code, invocation…"
              aria-label="Search dbt logs"
              className="h-9 border-slate-700 bg-slate-950 pl-9 text-slate-100 placeholder:text-slate-500"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setWrap((value) => !value)}
              aria-pressed={wrap}
              className={cn("text-slate-300 hover:bg-slate-800 hover:text-white", wrap && "bg-slate-800 text-white")}
            >
              <WrapText /> Wrap
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setFollow((value) => !value)}
              aria-pressed={follow}
              className={cn("text-slate-300 hover:bg-slate-800 hover:text-white", follow && "bg-slate-800 text-white")}
            >
              <ChevronsDown /> {running ? "Live tail" : "Follow"}
            </Button>
            <Button type="button" size="icon" variant="ghost" onClick={copyLogs} title="Copy logs" className="h-8 w-8 text-slate-300 hover:bg-slate-800 hover:text-white">
              {copied ? <Check /> : <Copy />}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => downloadTextFile(`dbt-run-${runId}.log`, logs)}
              title="Download raw log"
              className="h-8 w-8 text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <Download />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {LOG_LEVELS.map((level) => {
            const active = enabledLevels.has(level)
            return (
              <button
                key={level}
                type="button"
                onClick={() => toggleLevel(level)}
                aria-pressed={active}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition-opacity",
                  active ? LEVEL_BUTTON_STYLES[level] : "border-slate-700 bg-transparent text-slate-500 opacity-60",
                )}
              >
                {level} {levelCounts[level]}
              </button>
            )
          })}
          <span className="ml-auto text-xs tabular-nums text-slate-500">
            {filteredEntries.length.toLocaleString()} / {entries.length.toLocaleString()} lines
          </span>
        </div>
      </div>

      {filteredEntries.length > MAX_RENDERED_LINES && (
        <div className="border-b border-amber-500/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-200">
          Rendering {MAX_RENDERED_LINES.toLocaleString()} of {filteredEntries.length.toLocaleString()} matching lines to keep the console responsive. Narrow the search to see a specific event.
        </div>
      )}

      <div
        ref={viewportRef}
        role="log"
        aria-label="dbt command output"
        className="max-h-[34rem] min-h-64 overflow-auto font-mono text-xs leading-5"
      >
        {visibleEntries.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-4 text-center text-slate-500">
            {logs ? "No log lines match the current filters." : running ? "Waiting for dbt output…" : "No console output was captured for this run."}
          </div>
        ) : (
          <div className="min-w-max py-2">
            {visibleEntries.map((entry) => (
              <div
                key={`${entry.lineNumber}-${entry.raw}`}
                className={cn(
                  "grid grid-cols-[3.5rem_7.5rem_4.5rem_minmax(20rem,1fr)] border-l-2 border-transparent px-2 hover:border-sky-500 hover:bg-slate-900",
                  entry.level === "error" && "bg-red-950/20",
                )}
              >
                <span className="select-none pr-3 text-right tabular-nums text-slate-700">{entry.lineNumber}</span>
                <span className="pr-3 tabular-nums text-slate-500">{displayTimestamp(entry.timestamp)}</span>
                <span className={cn("pr-3 font-semibold uppercase", LEVEL_STYLES[entry.level])}>{entry.level}</span>
                <span className={cn("pr-4 text-slate-200", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
                  {entry.message || " "}
                  {(entry.code || entry.thread) && (
                    <span className="ml-2 text-slate-600">{[entry.code, entry.thread].filter(Boolean).join(" · ")}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
