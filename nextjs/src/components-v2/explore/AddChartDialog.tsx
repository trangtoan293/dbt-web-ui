"use client"

import { useEffect, useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components-v2/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components-v2/ui/dialog'
import CodeEditor from '@/components-v2/shared/CodeEditor'
import { apiClient } from '@/lib/api/client'
import { numericChartColumns } from '@/lib/query-chart'
import { starterQuery, type DataEntry } from '@/lib/explore-data'
import { chartPayload, chartReady, emptyChartDraft, suggestChart, type BoardOutline, type ChartDraft } from '@/lib/board'
import { cn } from '@/lib/utils'
import ChartBuilder from './ChartBuilder'

interface Preview { columns: string[]; rows: unknown[][]; row_count: number }
type Source = 'new' | 'existing'

const CONTROL = 'mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs'

/**
 * Add a chart to a dashboard: the data on the left, the chart on the right.
 *
 * The right half is the same builder the SQL console uses, so the chart is
 * drawn here before it is written into the YAML - what goes in is what was
 * seen. What is inserted is still the *query*, not these rows, so the
 * dashboard refreshes against the warehouse.
 */
export default function AddChartDialog({ projectId, open, onOpenChange, yaml, target, values, outline, entries, onInserted }: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  yaml: string
  target: string
  values: Record<string, unknown>
  outline: BoardOutline | null
  entries: DataEntry[]
  onInserted: (yaml: string, message: string) => void
}) {
  const [source, setSource] = useState<Source>('new')
  const [model, setModel] = useState('')
  const [sql, setSql] = useState('')
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [draft, setDraft] = useState<ChartDraft>(emptyChartDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const endpoint = `/charts/${projectId}/board`
  const queries = outline?.queries ?? []
  // The builder redraws when its rows change identity, so build them once.
  const rows = useMemo(() => preview
    ? preview.rows.map(row => Object.fromEntries(preview.columns.map((column, index) => [column, row[index]])))
    : [], [preview])

  useEffect(() => {
    if (!open) return
    setSource('new'); setModel(''); setSql(''); setQuery(queries[0] ?? '')
    setPreview(null); setDraft(emptyChartDraft()); setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setBusy(true); setError(''); setPreview(null)
    try {
      const result = source === 'new'
        ? await apiClient.post<Preview>(`${endpoint}/sql`, { yaml, sql, target })
        : await apiClient.post<Preview>(`${endpoint}/query`, { yaml, name: query, variables: values, target })
      setPreview(result)
      if (!result.columns.length) { setError('That query returned no columns.'); return }
      const next = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))
      setDraft(current => suggestChart(result.columns, numericChartColumns(next, result.columns), current))
    } catch (issue) { setError((issue as Error).message) } finally { setBusy(false) }
  }

  async function insert() {
    setBusy(true); setError('')
    try {
      const chart = { ...chartPayload(draft), ...(source === 'new' ? { sql } : { query }) }
      const result = await apiClient.post<{ yaml: string; name: string; query: string; notice: string | null }>(
        `${endpoint}/chart`, { yaml, chart, columns: preview?.columns ?? [] })
      onInserted(result.yaml, result.notice
        || `Added chart ${result.name}${source === 'new' ? ` and query ${result.query}` : ''}. Refresh to draw it on the dashboard.`)
      onOpenChange(false)
    } catch (issue) { setError((issue as Error).message) } finally { setBusy(false) }
  }

  const runnable = source === 'new' ? !!sql.trim() : !!query
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90dvh] max-w-5xl overflow-y-auto">
    <DialogHeader>
      <DialogTitle>Add a chart</DialogTitle>
      <DialogDescription>Pick the data, run it, and see the chart before it goes in. The query is saved with the chart, so the dashboard refreshes it.</DialogDescription>
    </DialogHeader>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="min-w-0 space-y-2">
        <h3 className="text-xs font-semibold text-slate-800">1 · The data</h3>
        <div className="flex gap-1" role="group" aria-label="Data source">
          {([['new', 'Query a model'], ['existing', 'A query already in this dashboard']] as const).map(([id, label]) =>
            <button key={id} type="button" aria-pressed={source === id} disabled={id === 'existing' && !queries.length}
              onClick={() => { setSource(id); setPreview(null); setError('') }}
              className={cn('rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-40',
                source === id ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>{label}</button>)}
        </div>

        {source === 'new' ? <>
          <label className="block text-xs text-slate-600">Model or source
            <select aria-label="Model or source" className={CONTROL} value={model} disabled={busy}
              onChange={event => {
                const entry = entries.find(item => item.id === event.target.value)
                setModel(event.target.value); setPreview(null)
                if (entry) setSql(starterQuery(entry))
              }}>
              <option value="">{entries.length ? 'Select a model to start the SQL' : 'No project metadata — write SQL below'}</option>
              {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.kind} · {entry.name}</option>)}
            </select></label>
          {/* The same editor as the SQL console: dbt completions, ⌘↵ to run. */}
          <div className="h-44 overflow-hidden rounded-md border border-slate-200">
            <CodeEditor value={sql} readOnly={busy} onChange={value => { setSql(value ?? ''); setPreview(null) }}
              onRun={run} onPreview={run} dataEntries={entries} />
          </div>
          <p className="text-[11px] text-slate-500">One SELECT, with <code>{'{{ ref() }}'}</code> or <code>{'{{ source() }}'}</code>. Aggregate here — a chart draws the rows the query returns, up to 1,000.</p>
        </> : <label className="block text-xs text-slate-600">Dashboard query
          <select aria-label="Dashboard query" className={CONTROL} value={query} disabled={busy}
            onChange={event => { setQuery(event.target.value); setPreview(null) }}>{queries.map(name => <option key={name}>{name}</option>)}</select></label>}

        <Button size="sm" variant="outline" disabled={busy || !runnable} onClick={run}><Play />{busy ? 'Running…' : 'Run query'}</Button>
        {error && <p role="alert" className="whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}

        {preview && preview.columns.length > 0 && <details className="rounded border border-slate-200">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-slate-600">{preview.row_count.toLocaleString()} rows returned · show the first {Math.min(8, preview.rows.length)}</summary>
          <div className="max-h-40 overflow-auto border-t border-slate-200">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-slate-50"><tr>{preview.columns.map(column => <th key={column} className="px-2 py-1 font-medium text-slate-600">{column}</th>)}</tr></thead>
              <tbody>{preview.rows.slice(0, 8).map((row, index) => <tr key={index} className="border-t border-slate-100">
                {row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-40 truncate px-2 py-1 font-mono text-slate-700">{cell === null ? '—' : String(cell)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>}
      </section>

      <section className="min-w-0 space-y-2">
        <h3 className="text-xs font-semibold text-slate-800">2 · The chart</h3>
        {preview && preview.columns.length > 0
          ? <ChartBuilder data={rows} columns={preview.columns} draft={draft} onDraft={setDraft} height="h-64" />
          : <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-slate-200 px-6 text-center text-xs text-slate-500">
            Run the query and the chart is drawn here, exactly as the dashboard will draw it.
          </div>}
      </section>
    </div>

    <div className="flex items-center gap-2 border-t pt-3">
      <Button size="sm" disabled={busy || !preview || !chartReady(draft, preview.columns)} onClick={insert}>Add to dashboard</Button>
      <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
      <span className="text-[11px] text-slate-500">Inserted into the YAML; existing charts and comments are kept.</span>
    </div>
  </DialogContent></Dialog>
}
