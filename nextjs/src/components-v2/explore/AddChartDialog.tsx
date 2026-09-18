"use client"

import { useEffect, useState } from 'react'
import { Button } from '@/components-v2/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components-v2/ui/dialog'
import { apiClient } from '@/lib/api/client'
import { numericChartColumns } from '@/lib/query-chart'
import { starterQuery, type DataEntry } from '@/lib/explore-data'
import { chartPayload, chartReady, emptyChartDraft, suggestChart, type BoardOutline, type ChartDraft } from '@/lib/board'
import { cn } from '@/lib/utils'
import ChartFields from './ChartFields'

interface Preview { columns: string[]; rows: unknown[][]; row_count: number }
type Source = 'new' | 'existing'

const CONTROL = 'mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs'

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
  const numeric = preview ? numericChartColumns(
    preview.rows.map(row => Object.fromEntries(preview.columns.map((column, index) => [column, row[index]]))), preview.columns) : []

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
      const rows = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])))
      setDraft(current => suggestChart(result.columns, numericChartColumns(rows, result.columns), current))
    } catch (issue) { setError((issue as Error).message) } finally { setBusy(false) }
  }

  async function insert() {
    setBusy(true); setError('')
    try {
      const chart = { ...chartPayload(draft), ...(source === 'new' ? { sql } : { query }) }
      const result = await apiClient.post<{ yaml: string; name: string; query: string; notice: string | null }>(
        `${endpoint}/chart`, { yaml, chart, columns: preview?.columns ?? [] })
      onInserted(result.yaml, result.notice
        || `Added chart ${result.name}${source === 'new' ? ` and query ${result.query}` : ''}. Preview to render it.`)
      onOpenChange(false)
    } catch (issue) { setError((issue as Error).message) } finally { setBusy(false) }
  }

  const runnable = source === 'new' ? !!sql.trim() : !!query
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
    <DialogHeader>
      <DialogTitle>Add a chart</DialogTitle>
      <DialogDescription>Pick the data, run it to see the real columns, then choose how to draw them. The SQL is saved into the dashboard with the chart.</DialogDescription>
    </DialogHeader>

    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-slate-800">1 · Choose the data</h3>
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
        <label className="block text-xs text-slate-600">SQL
          <textarea aria-label="Chart SQL" rows={5} className="mt-1 w-full rounded-md border border-slate-200 p-2 font-mono text-[11px]"
            spellCheck={false} value={sql} disabled={busy} onChange={event => { setSql(event.target.value); setPreview(null) }}
            placeholder={"select region, sum(amount) as total\nfrom {{ ref('orders') }}\ngroup by 1"} /></label>
        <p className="text-[11px] text-slate-500">One SELECT, with <code>{'{{ ref() }}'}</code> or <code>{'{{ source() }}'}</code>. Aggregate here — a chart draws the rows the query returns, up to 1,000.</p>
      </> : <label className="block text-xs text-slate-600">Dashboard query
        <select aria-label="Dashboard query" className={CONTROL} value={query} disabled={busy}
          onChange={event => { setQuery(event.target.value); setPreview(null) }}>{queries.map(name => <option key={name}>{name}</option>)}</select></label>}

      <Button size="sm" variant="outline" disabled={busy || !runnable} onClick={run}>{busy ? 'Running…' : 'Run and preview data'}</Button>
      {error && <p role="alert" className="whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    </section>

    {preview && preview.columns.length > 0 && <section className="space-y-2">
      <h3 className="text-xs font-semibold text-slate-800">2 · Build the chart</h3>
      <div className="max-h-40 overflow-auto rounded border border-slate-200">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-slate-50"><tr>{preview.columns.map(column => <th key={column} className="px-2 py-1 font-medium text-slate-600">{column}</th>)}</tr></thead>
          <tbody>{preview.rows.slice(0, 8).map((row, index) => <tr key={index} className="border-t border-slate-100">
            {row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-40 truncate px-2 py-1 font-mono text-slate-700">{cell === null ? '—' : String(cell)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">{preview.row_count.toLocaleString()} rows returned · showing the first {Math.min(8, preview.rows.length)}.</p>
      <ChartFields columns={preview.columns} numeric={numeric} value={draft} onChange={setDraft} />
    </section>}

    <div className="flex items-center gap-2 border-t pt-3">
      <Button size="sm" disabled={busy || !preview || !chartReady(draft, preview.columns)} onClick={insert}>Add to dashboard</Button>
      <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
      <span className="text-[11px] text-slate-500">Inserted into the YAML; existing charts and comments are kept.</span>
    </div>
  </DialogContent></Dialog>
}
