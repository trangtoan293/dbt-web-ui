"use client"

import React, { useEffect, useMemo, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { numericChartColumns } from "@/lib/query-chart"
import { SNAPSHOT_TYPES, emptyChartDraft, suggestChart, type ChartDraft } from "@/lib/board"
import ChartBuilder, { type RenderedChart } from "./ChartBuilder"

interface Props {
  data: Record<string, unknown>[]
  columns: string[]
  onAddToDashboard?: (yaml: string) => void
}

const CONTROL = "mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"

/** Query results, charted. The builder itself is shared with the dashboard's Add chart. */
export default function QueryChart({ data, columns, onAddToDashboard }: Props) {
  const numeric = useMemo(() => numericChartColumns(data, columns), [data, columns])
  const [draft, setDraft] = useState<ChartDraft>(() => suggestChart(columns, numeric, { ...emptyChartDraft(), type: numeric.length ? "bar" : "table", title: "Query results" }))
  const [theme, setTheme] = useState("clarity")

  // New result columns re-seed the fields rather than charting a column that is gone.
  useEffect(() => {
    setDraft(current => columns.includes(current.fields.x) && numeric.includes(current.fields.y)
      ? current : suggestChart(columns, numeric, { ...current, series: "" }))
  }, [columns, numeric])

  function download(rendered: RenderedChart, format: "html" | "yaml") {
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
      <ChartBuilder data={data} columns={columns} draft={draft} onDraft={setDraft} types={SNAPSHOT_TYPES} theme={theme} height="h-[480px]"
        actions={rendered => <>
          {onAddToDashboard && <Button size="sm" onClick={() => onAddToDashboard(rendered.yaml)}>Add to dashboard</Button>}
          <Button size="sm" variant="outline" onClick={() => download(rendered, "html")}><Download className="h-4 w-4" /> HTML</Button>
          <Button size="sm" variant="outline" onClick={() => download(rendered, "yaml")}><Download className="h-4 w-4" /> Board YAML</Button>
          <span className="text-xs text-slate-500">Exports include these result rows. {rendered.renderer}</span>
        </>}>
        <label className="text-xs text-slate-600">Theme
          <select aria-label="Chart theme" className={CONTROL} value={theme} onChange={event => setTheme(event.target.value)}>
            {["clarity", "paper", "vivid", "neon", "stark"].map(item => <option key={item}>{item}</option>)}
          </select></label>
      </ChartBuilder>
    </div>
  )
}
