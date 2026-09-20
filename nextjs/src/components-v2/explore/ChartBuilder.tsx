"use client"

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getSession } from 'next-auth/react'
import { chartRows, numericChartColumns, sandboxChartHtml } from '@/lib/query-chart'
import { acceptsSeries, chartProblem, type BoardDiagnostic, type ChartDraft } from '@/lib/board'
import ChartFields from './ChartFields'

export interface RenderedChart { html: string; yaml: string; warnings: BoardDiagnostic[]; renderer: string }

/**
 * The one chart builder: fields on top, the drawn chart underneath. Both places
 * that build a chart use it - SQL results and a dashboard's Add chart - so what
 * you configure is what you see before you commit to it anywhere.
 *
 * The chart follows the fields. There is no Build button because the renderer
 * draws from rows the browser already holds: no warehouse query, no cost per
 * redraw. Keystrokes are absorbed by a short delay, and the last change wins.
 */
export default function ChartBuilder({ data, columns, draft, onDraft, types, theme = 'clarity', height = 'h-[420px]', actions, children }: {
  data: Record<string, unknown>[]
  columns: string[]
  draft: ChartDraft
  onDraft: (draft: ChartDraft) => void
  /** Chart types to offer; all of them when omitted. */
  types?: string[]
  theme?: string
  height?: string
  /** Buttons that need the rendered result - downloads, add to dashboard. */
  actions?: (rendered: RenderedChart) => React.ReactNode
  /** Extra controls placed inside the field grid. */
  children?: React.ReactNode
}) {
  const numeric = useMemo(() => numericChartColumns(data, columns), [data, columns])
  const [rendered, setRendered] = useState<RenderedChart | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const problem = chartProblem(draft, data.length, columns, numeric)

  useEffect(() => {
    request.current?.abort()
    setRendered(null); setError(null); setBusy(!problem)
    if (problem) return
    const abort = new AbortController()
    request.current = abort
    const timer = setTimeout(async () => {
      try {
        const session = await getSession()
        const value = draft.type === 'table' ? '' : draft.fields.y ?? ''
        const response = await fetch('/api/dbt-runner/charts/render', {
          method: 'POST', signal: abort.signal,
          headers: { 'Content-Type': 'application/json', ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}) },
          body: JSON.stringify({
            data: chartRows(data, columns, value), columns, theme,
            chart_type: draft.type, title: draft.title, number_format: draft.format || null,
            x: draft.type === 'table' || draft.type === 'kpi' ? null : draft.fields.x ?? null,
            y: value || null,
            color: acceptsSeries(draft.type) && draft.series ? draft.series : null,
          }),
        })
        const body = await response.json()
        if (!response.ok) {
          const detail = Array.isArray(body.detail) ? body.detail.map((item: { msg?: string }) => item.msg).join('; ') : body.detail
          throw new Error(detail || body.error || 'Chart rendering failed')
        }
        if (!abort.signal.aborted) { setRendered({ ...body, html: sandboxChartHtml(body.html) }); setBusy(false) }
      } catch (issue) {
        if (abort.signal.aborted) return
        setError(issue instanceof Error ? issue.message : 'Unable to render chart'); setBusy(false)
      }
    }, 350)
    return () => { clearTimeout(timer); abort.abort() }
  }, [data, columns, draft, theme, problem])

  return <div className="space-y-3">
    <ChartFields columns={columns} numeric={numeric} value={draft} onChange={onDraft} types={types}>{children}</ChartFields>
    {problem && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">{problem}</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    {rendered
      ? <>
        <iframe title={draft.title || 'Chart preview'} srcDoc={rendered.html} sandbox="allow-scripts" referrerPolicy="no-referrer"
          className={`w-full rounded-lg border border-slate-200 bg-white ${height}`} />
        {rendered.warnings.map((warning, index) => <p key={index} className="text-xs text-amber-700">{warning.message}{warning.fix ? ` Fix: ${warning.fix}` : ''}</p>)}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions(rendered)}</div>}
      </>
      : !problem && !error && <div className={`flex items-center justify-center rounded-lg border border-dashed border-slate-200 text-sm text-slate-500 ${height}`}>
        {busy ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Drawing with dbt-charts…</span> : 'Choose your fields to draw the chart.'}
      </div>}
  </div>
}
