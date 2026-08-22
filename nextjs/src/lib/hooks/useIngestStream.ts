"use client"

import { useCallback, useRef, useState } from "react"
import { getSession } from "next-auth/react"

export type IngestEvent =
  | { type: "started"; dataset: string; tables: string[] }
  | { type: "log"; message: string }
  | { type: "completed"; dataset?: string; destination?: string; row_counts?: Record<string, number> }
  | { type: "error"; message: string }

/**
 * Stream one ingest job from dbt-runner.
 *
 * POST + ReadableStream rather than EventSource, for the same reason
 * useDbtRunStream does it: EventSource cannot send a body or an Authorization
 * header.
 */
export function useIngestStream() {
  const [logs, setLogs] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<IngestEvent | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }, [])

  const run = useCallback(
    async (sourceId: string, options: { tables?: string[]; writeDisposition?: string; fullRefresh?: boolean } = {}) => {
      if (abortRef.current) return
      const controller = new AbortController()
      abortRef.current = controller
      setLogs([])
      setResult(null)
      setRunning(true)

      try {
        const session = await getSession()
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`

        const response = await fetch(`/api/dbt-runner/sse/ingest/${sourceId}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            tables: options.tables,
            write_disposition: options.writeDisposition,
            full_refresh: options.fullRefresh ?? false,
          }),
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          const detail = await response.json().catch(() => null)
          setResult({ type: "error", message: detail?.detail || `Ingest failed: ${response.status}` })
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            let event: IngestEvent
            try {
              event = JSON.parse(line.slice(6))
            } catch {
              continue
            }
            if (event.type === "log") setLogs((prev) => [...prev, event.message])
            else if (event.type === "started") setLogs((prev) => [...prev, `Loading ${event.tables.join(", ")} into ${event.dataset}`])
            else setResult(event)
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setResult({ type: "error", message: err instanceof Error ? err.message : "Network error" })
        }
      } finally {
        abortRef.current = null
        setRunning(false)
      }
    },
    [],
  )

  return { logs, running, result, run, stop }
}
