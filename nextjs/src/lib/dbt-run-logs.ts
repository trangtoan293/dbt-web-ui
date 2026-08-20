export type DbtLogLevel = "debug" | "info" | "warn" | "error" | "success" | "unknown"

export type DbtLogEntry = {
  lineNumber: number
  timestamp: string | null
  level: DbtLogLevel
  message: string
  raw: string
  code: string | null
  eventName: string | null
  thread: string | null
  invocationId: string | null
}

export type DbtTimingEntry = {
  name?: string
  started_at?: string
  completed_at?: string
}

export type DbtNodeResult = {
  unique_id?: string
  status?: string
  thread_id?: string
  execution_time?: number
  timing?: DbtTimingEntry[]
  message?: string | null
  failures?: number | null
  adapter_response?: Record<string, unknown>
  compiled?: boolean
  compiled_code?: string | null
  relation_name?: string | null
}

export type DbtRunResults = {
  metadata?: {
    dbt_schema_version?: string
    dbt_version?: string
    generated_at?: string
    invocation_id?: string
    env?: Record<string, string>
  }
  args?: Record<string, unknown>
  elapsed_time?: number
  results?: DbtNodeResult[]
}

export type DbtInvocationMetadata = {
  invocationId: string | null
  dbtVersion: string | null
  generatedAt: string | null
  schemaVersion: string | null
  elapsedTime: number | null
  command: string | null
  target: string | null
  threads: number | null
  failFast: boolean | null
  fullRefresh: boolean | null
}

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const TEXT_LOG_PREFIX = /^(?<timestamp>\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?:\[(?<level>debug|info|warn|warning|error)\s*\]\s*)?(?:\[(?<thread>[^\]]+)\]:\s*)?(?<message>.*)$/i
const ISO_LOG_PREFIX = /^(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(?<message>.*)$/i

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "")
}

function normalizeLevel(value: unknown): DbtLogLevel {
  const level = String(value || "").toLowerCase()
  if (level === "warning") return "warn"
  if (["debug", "info", "warn", "error", "success"].includes(level)) {
    return level as DbtLogLevel
  }
  return "unknown"
}

function inferTextLevel(message: string): DbtLogLevel {
  const value = message.toLowerCase()
  if (/\b(error|failed|failure|fatal|exception|traceback)\b/.test(value)) return "error"
  if (/\b(warn|warning|deprecated)\b/.test(value)) return "warn"
  if (/\b(ok created|pass(?:ed)?|success(?:ful)?|completed successfully)\b/.test(value)) return "success"
  if (/\b(debug|partial parsing|cache event)\b/.test(value)) return "debug"
  if (value.trim()) return "info"
  return "unknown"
}

function parseJsonLog(raw: string, lineNumber: number): DbtLogEntry | null {
  if (!raw.trimStart().startsWith("{")) return null

  try {
    const parsed = JSON.parse(raw) as {
      info?: {
        ts?: string
        level?: string
        msg?: string
        code?: string
        name?: string
        thread?: string
        invocation_id?: string
      }
      data?: { msg?: string }
      timestamp?: string
      level?: string
      message?: string
      msg?: string
    }
    const info = parsed.info
    const message = info?.msg || parsed.message || parsed.msg || parsed.data?.msg
    if (!message) return null

    return {
      lineNumber,
      timestamp: info?.ts || parsed.timestamp || null,
      level: normalizeLevel(info?.level || parsed.level) || "unknown",
      message: String(message),
      raw,
      code: info?.code || null,
      eventName: info?.name || null,
      thread: info?.thread || null,
      invocationId: info?.invocation_id || null,
    }
  } catch {
    return null
  }
}

export function parseDbtLogLine(value: string, lineNumber: number): DbtLogEntry {
  const raw = stripAnsi(value).replace(/\r$/, "")
  const jsonEntry = parseJsonLog(raw, lineNumber)
  if (jsonEntry) return jsonEntry

  const textMatch = raw.match(TEXT_LOG_PREFIX)
  if (textMatch?.groups) {
    const message = textMatch.groups.message || raw
    const explicitLevel = normalizeLevel(textMatch.groups.level)
    return {
      lineNumber,
      timestamp: textMatch.groups.timestamp || null,
      level: explicitLevel === "unknown" ? inferTextLevel(message) : explicitLevel,
      message,
      raw,
      code: null,
      eventName: null,
      thread: textMatch.groups.thread || null,
      invocationId: null,
    }
  }

  const isoMatch = raw.match(ISO_LOG_PREFIX)
  if (isoMatch?.groups) {
    const message = isoMatch.groups.message || raw
    return {
      lineNumber,
      timestamp: isoMatch.groups.timestamp || null,
      level: inferTextLevel(message),
      message,
      raw,
      code: null,
      eventName: null,
      thread: null,
      invocationId: null,
    }
  }

  return {
    lineNumber,
    timestamp: null,
    level: inferTextLevel(raw),
    message: raw,
    raw,
    code: null,
    eventName: null,
    thread: null,
    invocationId: null,
  }
}

export function parseDbtLogs(value: string | null | undefined): DbtLogEntry[] {
  if (!value) return []
  return value.split(/\r?\n/).map((line, index) => parseDbtLogLine(line, index + 1))
}

export function filterDbtLogEntries(
  entries: DbtLogEntry[],
  query: string,
  enabledLevels: ReadonlySet<DbtLogLevel>,
): DbtLogEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  return entries.filter((entry) => {
    if (!enabledLevels.has(entry.level)) return false
    if (!normalizedQuery) return true
    return [entry.message, entry.code, entry.eventName, entry.thread, entry.invocationId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery))
  })
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

export function getDbtInvocationMetadata(value: unknown): DbtInvocationMetadata {
  const results = (value && typeof value === "object" ? value : {}) as DbtRunResults
  const args = results.args || {}
  return {
    invocationId: asString(results.metadata?.invocation_id),
    dbtVersion: asString(results.metadata?.dbt_version),
    generatedAt: asString(results.metadata?.generated_at),
    schemaVersion: asString(results.metadata?.dbt_schema_version),
    elapsedTime: asNumber(results.elapsed_time),
    command: asString(args.which) || asString(args.invocation_command),
    target: asString(args.target),
    threads: asNumber(args.threads),
    failFast: asBoolean(args.fail_fast),
    fullRefresh: asBoolean(args.full_refresh),
  }
}

export function getDbtNodeResults(value: unknown): DbtNodeResult[] {
  if (!value || typeof value !== "object") return []
  const results = (value as DbtRunResults).results
  return Array.isArray(results) ? results.filter((entry) => entry && typeof entry === "object") : []
}

export function timingDurationMs(timing: DbtTimingEntry): number | null {
  if (!timing.started_at || !timing.completed_at) return null
  const startedAt = new Date(timing.started_at).getTime()
  const completedAt = new Date(timing.completed_at).getTime()
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return null
  return Math.max(0, completedAt - startedAt)
}
