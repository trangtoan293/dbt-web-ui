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

/**
 * Why this draft cannot be drawn from these rows yet, or null when it can.
 * The snapshot renderer draws the chart from rows the browser already has, so
 * these are the limits it enforces - checked before asking, not after failing.
 */
export function chartProblem(draft: ChartDraft, rows: number, columns: string[], numeric: string[]): string | null {
  const kind = draft.type
  if (!SNAPSHOT_TYPES.includes(kind)) return `A ${kind} is drawn by the dashboard itself - this preview covers the other chart types.`
  if (rows > 1000) return 'Charts support up to 1,000 result rows. Reduce the query limit.'
  if (columns.length > 80) return 'Choose up to 80 columns in your query.'
  if (kind === 'kpi' && rows !== 1) return 'KPI needs one row. Aggregate your SQL to a single metric first.'
  if (kind !== 'table' && !numeric.includes(draft.fields.y ?? '')) return 'Choose a numeric value column. Cast numeric text in SQL if necessary.'
  if (kind !== 'table' && kind !== 'kpi' && !columns.includes(draft.fields.x ?? '')) return 'Choose an X-axis or category column.'
  return null
}

/** The workspace shows a board two ways, the way a published dashboard does. */
export type BoardMode = 'view' | 'edit'

/** A board is blank once its comments are stripped - those are the template's prose. */
export const boardEmpty = (yaml: string) => !yaml.replace(/^\s*#.*$/gm, '').trim()

/** View renders the saved file (what a reader opens); editing renders the unsaved draft. */
export const boardSource = (mode: BoardMode, draft: string, published: string) => mode === 'view' ? published : draft

/** Opening a published board renders it - no Preview click, and no repeat of what is already on screen. */
export const boardNeedsRender = (mode: BoardMode, published: string, rendered: string) =>
  mode === 'view' && !boardEmpty(published) && rendered !== published
