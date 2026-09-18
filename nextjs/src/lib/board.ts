/** Shapes shared by the dashboard workspace, its dialogs and the board endpoints. */

export interface BoardDiagnostic {
  message: string
  level: string
  code?: string | null
  fix?: string | null
  chart?: string | null
  path?: string | null
  line?: number | null
}

export interface BoardVariable {
  input?: string
  label?: string
  default?: unknown
  required?: boolean
  notes?: string
  options?: { static?: unknown[] }
}

export interface BoardOutline {
  queries: string[]
  charts: { name: string; type: string; query: string | null }[]
}

export interface ChartChannel {
  key: 'x' | 'y' | 'color'
  label: string
}

/** Authorable types the chart builder offers; the engine validates the rest of the board. */
export const CHART_TYPES: { value: string; label: string; channels: ChartChannel[] }[] = [
  { value: 'bar', label: 'Bar', channels: [{ key: 'x', label: 'Category' }, { key: 'y', label: 'Value' }] },
  { value: 'line', label: 'Line', channels: [{ key: 'x', label: 'X axis' }, { key: 'y', label: 'Value' }] },
  { value: 'area', label: 'Area', channels: [{ key: 'x', label: 'X axis' }, { key: 'y', label: 'Value' }] },
  { value: 'scatter', label: 'Scatter', channels: [{ key: 'x', label: 'X axis' }, { key: 'y', label: 'Y axis' }] },
  { value: 'pie', label: 'Pie', channels: [{ key: 'x', label: 'Category' }, { key: 'y', label: 'Value' }] },
  { value: 'donut', label: 'Donut', channels: [{ key: 'x', label: 'Category' }, { key: 'y', label: 'Value' }] },
  { value: 'histogram', label: 'Histogram', channels: [{ key: 'x', label: 'Value to bin' }] },
  { value: 'heatmap', label: 'Heatmap', channels: [{ key: 'x', label: 'X axis' }, { key: 'y', label: 'Y axis' }, { key: 'color', label: 'Value' }] },
  { value: 'kpi', label: 'KPI', channels: [{ key: 'y', label: 'Value' }] },
  { value: 'table', label: 'Table', channels: [] },
]

/** Engine format aliases. Without one the renderer warns that a measure is unformatted. */
export const NUMBER_FORMATS = ['', 'integer', 'number', 'number_full', 'currency', 'currency_whole',
  'currency_full', 'percent', 'percent_whole', 'percent_delta']

/** The snapshot renderer accepts these; a board additionally takes histogram and heatmap. */
export const SNAPSHOT_TYPES = ['bar', 'line', 'area', 'scatter', 'pie', 'donut', 'kpi', 'table']

const SERIES_TYPES = ['bar', 'line', 'area', 'scatter']
export const acceptsSeries = (type: string) => SERIES_TYPES.includes(type)

/** Board endpoints answer 422 with {message, diagnostics}; keep the engine's fix text. */
export function boardDiagnostics(error: unknown): BoardDiagnostic[] {
  const detail = (error as { details?: { detail?: { diagnostics?: unknown } } })?.details?.detail
  return Array.isArray(detail?.diagnostics) ? (detail.diagnostics as BoardDiagnostic[]) : []
}

export function diagnosticText(item: BoardDiagnostic): string {
  return [item.line ? `Line ${item.line}` : null, item.chart ? `chart ${item.chart}` : null]
    .filter(Boolean).join(' · ') + (item.line || item.chart ? ': ' : '') + item.message
}

export interface ChartDraft {
  type: string
  fields: Record<string, string>
  series: string
  title: string
  format: string
}

export const emptyChartDraft = (): ChartDraft => ({ type: 'bar', fields: {}, series: '', title: '', format: '' })

/** First non-numeric column reads as the dimension, first numeric one as the measure. */
export function suggestChart(columns: string[], numeric: string[], draft: ChartDraft): ChartDraft {
  const dimension = columns.find(column => !numeric.includes(column)) ?? columns[0] ?? ''
  const measure = numeric[0] ?? columns[0] ?? ''
  return { ...draft, fields: { x: dimension, y: measure, color: measure } }
}

export function chartPayload(draft: ChartDraft): Record<string, unknown> {
  const channels = CHART_TYPES.find(item => item.value === draft.type)?.channels ?? []
  return {
    type: draft.type,
    title: draft.title,
    number_format: draft.format || undefined,
    ...Object.fromEntries(channels.map(channel => [channel.key, draft.fields[channel.key]])),
    ...(acceptsSeries(draft.type) && draft.series ? { color: draft.series } : {}),
  }
}

export const chartReady = (draft: ChartDraft, columns: string[]) =>
  (CHART_TYPES.find(item => item.value === draft.type)?.channels ?? []).every(channel => columns.includes(draft.fields[channel.key]))
