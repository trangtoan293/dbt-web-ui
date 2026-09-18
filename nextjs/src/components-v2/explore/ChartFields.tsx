"use client"

import { CHART_TYPES, NUMBER_FORMATS, acceptsSeries, type ChartDraft } from '@/lib/board'

const CONTROL = 'mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'

/**
 * One chart configurator for both places a chart is built: SQL results and a
 * dashboard. Same controls, same wording, whatever the data came from.
 */
export default function ChartFields({ columns, numeric, value, onChange, types, children }: {
  columns: string[]
  numeric: string[]
  value: ChartDraft
  onChange: (draft: ChartDraft) => void
  types?: string[]
  children?: React.ReactNode
}) {
  const offered = CHART_TYPES.filter(item => !types || types.includes(item.value))
  const channels = CHART_TYPES.find(item => item.value === value.type)?.channels ?? []
  const set = (patch: Partial<ChartDraft>) => onChange({ ...value, ...patch })
  const field = (key: string, next: string) => set({ fields: { ...value.fields, [key]: next } })
  // A measure channel only lists numeric columns; a dimension lists everything.
  const options = (key: string) => (key === 'x' && value.type !== 'histogram' ? columns : numeric.length ? numeric : columns)

  return <div className="grid gap-2 sm:grid-cols-3">
    <label className="text-xs text-slate-600">Chart type
      <select aria-label="Chart type" className={CONTROL} value={value.type} onChange={event => set({ type: event.target.value })}>
        {offered.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
    {channels.map(channel => <label key={channel.key} className="text-xs text-slate-600">{channel.label}
      <select aria-label={channel.label} className={CONTROL} value={value.fields[channel.key] ?? ''} onChange={event => field(channel.key, event.target.value)}>
        <option value="">Select a column</option>
        {options(channel.key).map(column => <option key={column}>{column}</option>)}
      </select></label>)}
    {acceptsSeries(value.type) && <label className="text-xs text-slate-600">Series (optional)
      <select aria-label="Series" className={CONTROL} value={value.series} onChange={event => set({ series: event.target.value })}>
        <option value="">One series</option>{columns.map(column => <option key={column}>{column}</option>)}
      </select></label>}
    {value.type !== 'table' && <label className="text-xs text-slate-600">Number format
      <select aria-label="Number format" className={CONTROL} value={value.format} onChange={event => set({ format: event.target.value })}>
        {NUMBER_FORMATS.map(item => <option key={item} value={item}>{item || 'Engine default'}</option>)}
      </select></label>}
    <label className="text-xs text-slate-600 sm:col-span-2">{value.type === 'kpi' ? 'Label' : 'Title'}
      <input className={CONTROL} maxLength={160} value={value.title} onChange={event => set({ title: event.target.value })}
        placeholder={value.type === 'kpi' ? 'What this number is' : 'Optional chart title'} /></label>
    {children}
  </div>
}
