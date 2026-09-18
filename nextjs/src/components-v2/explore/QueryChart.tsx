"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"
import { Download, Loader2, ChartColumn } from "lucide-react"
import { getSession } from "next-auth/react"
import { Button } from "@/components-v2/ui/button"
import { chartRows, numericChartColumns, sandboxChartHtml, type ChartKind } from "@/lib/query-chart"
import { SNAPSHOT_TYPES, acceptsSeries, emptyChartDraft, suggestChart, type BoardDiagnostic, type ChartDraft } from "@/lib/board"
import ChartFields from "./ChartFields"

interface Props {
  data: Record<string, unknown>[]
  columns: string[]
  onAddToDashboard?: (yaml: string) => void
}

interface RenderedChart {
  html: string
  yaml: string
  warnings: BoardDiagnostic[]
  renderer: string
}


const CONTROL = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"

export default function QueryChart({ data, columns, onAddToDashboard }: Props) {
  const numeric = useMemo(() => numericChartColumns(data, columns), [data, columns])
  const [draft, setDraft] = useState<ChartDraft>(() => suggestChart(columns, numeric, { ...emptyChartDraft(), type: numeric.length ? "bar" : "table", title: "Query results" }))
  const [theme, setTheme] = useState("clarity")
  const kind = draft.type as ChartKind
  const { x = "", y = "", } = draft.fields
  const color = draft.series
  const [rendered, setRendered] = useState<RenderedChart | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const revision = useRef(0)

  // New result columns re-seed the fields rather than charting a column that is gone.
  useEffect(() => {
    setDraft(current => columns.includes(current.fields.x) && numeric.includes(current.fields.y)
      ? current : suggestChart(columns, numeric, { ...current, series: "" }))
  }, [columns, numeric])

  // Never show a chart for previous rows or field selections as a current result.
  useEffect(() => {
    revision.current += 1
    controller.current?.abort()
    setRendered(null)
    setError(null)
    setBusy(false)
    return () => { controller.current?.abort() }
  }, [data, columns, draft, theme])

  const needsX = kind !== "table" && kind !== "kpi"
  const needsY = kind !== "table"
  const problem = data.length > 1000 ? "Charts support up to 1,000 result rows. Reduce the query limit."
    : columns.length > 80 ? "Choose up to 80 columns in your query."
    : kind === "kpi" && data.length !== 1 ? "KPI needs one row. Aggregate your SQL to a single metric first."
    : needsY && !numeric.includes(y) ? "Choose a numeric value column. Cast numeric text in SQL if necessary."
    : needsX && !columns.includes(x) ? "Choose an X-axis or category column."
    : null

  async function render() {
    if (problem) return
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const current = ++revision.current
    setBusy(true)
    setError(null)
    setRendered(null)
    try {
      const session = await getSession()
      const response = await fetch("/api/dbt-runner/charts/render", {
        method: "POST", signal: abort.signal,
        headers: { "Content-Type": "application/json", ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}) },
        body: JSON.stringify({ data: chartRows(data, columns, needsY ? y : ""), columns, theme,
          chart_type: kind, title: draft.title, number_format: draft.format || null,
          x: needsX ? x : null, y: needsY ? y : null,
          color: acceptsSeries(kind) && color ? color : null }),
      })
      const body = await response.json()
      if (!response.ok) {
        const detail = Array.isArray(body.detail) ? body.detail.map((item: { msg?: string }) => item.msg).join("; ") : body.detail
        throw new Error(detail || body.error || "Chart rendering failed")
      }
      if (current === revision.current && !abort.signal.aborted) setRendered({ ...body, html: sandboxChartHtml(body.html) })
    } catch (err) {
      if (!abort.signal.aborted && current === revision.current) setError(err instanceof Error ? err.message : "Unable to render chart")
    } finally {
      if (current === revision.current) setBusy(false)
    }
  }

  function download(format: "html" | "yaml") {
    if (!rendered) return
    const url = URL.createObjectURL(new Blob([rendered[format]], { type: format === "html" ? "text/html" : "application/yaml" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `query-chart.${format === "yaml" ? "yml" : "html"}`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="text-sm font-semibold text-slate-900">Visualize results</h3><p className="mt-1 text-xs text-slate-500">{data.length.toLocaleString()} returned rows · Aggregate in SQL before charting.</p></div>
        <span className="text-xs text-slate-400">Powered by dbt-charts</span>
      </div>
      <details open={!rendered}><summary className="mb-2 cursor-pointer text-xs text-slate-600">Chart settings</summary>
        <ChartFields columns={columns} numeric={numeric} value={draft} onChange={setDraft} types={SNAPSHOT_TYPES}>
          <label className="text-xs text-slate-600">Theme<select aria-label="Chart theme" className={CONTROL} value={theme} onChange={(event) => setTheme(event.target.value)}>{["clarity", "paper", "vivid", "neon", "stark"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <div className="flex items-end sm:col-span-3"><Button onClick={render} disabled={busy || !!problem}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChartColumn className="h-4 w-4" />} {busy ? "Rendering…" : "Build chart"}</Button></div>
        </ChartFields>
      </details>
      {problem && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{problem}</p>}
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {rendered ? <>
        {onAddToDashboard && <Button size="sm" onClick={() => onAddToDashboard(rendered.yaml)}>Add to dashboard</Button>}
        {rendered.warnings.map((warning, index) => <p key={index} className="text-xs text-amber-700">{warning.message}{warning.fix ? ` Fix: ${warning.fix}` : ""}</p>)}
        <iframe title={draft.title || "Query chart"} srcDoc={rendered.html} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-[480px] w-full rounded-lg border border-slate-200 bg-white" />
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => download("html")}><Download className="h-4 w-4" /> HTML</Button><Button size="sm" variant="outline" onClick={() => download("yaml")}><Download className="h-4 w-4" /> Board YAML</Button><span className="text-xs text-slate-500">Exports include these result rows. {rendered.renderer}</span></div>
      </> : !error && <div className="rounded-lg border border-dashed border-slate-200 p-10 text-center text-sm text-slate-500">{busy ? "Rendering with dbt-charts…" : "Choose your fields, then build a chart."}</div>}
    </div>
  )
}
