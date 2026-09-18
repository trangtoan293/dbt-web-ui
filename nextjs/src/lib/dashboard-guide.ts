import { columnExpression, type DataEntry } from './explore-data'

export type TemplateField = 'dimension' | 'measure' | 'date'

export interface TemplatePicks {
  dimension?: string
  measure?: string
  date?: string
}

export interface BoardTemplate {
  id: string
  title: string
  description: string
  fields: TemplateField[]
  build: (entry: DataEntry, picks: TemplatePicks) => string
}

const header = (entry: DataEntry, title: string) =>
  `# Uses the selected project's connection and Run on environment.\n` +
  `# Adjust the SQL for your warehouse dialect if it is not DuckDB or Postgres.\n` +
  `title: ${JSON.stringify(`${entry.name} ${title}`)}\n`

function pick(entry: DataEntry, picks: TemplatePicks, fields: TemplateField[]): Required<TemplatePicks> {
  for (const field of fields) {
    const name = picks[field]
    if (!name || !entry.columns.some(column => column.name === name)) {
      throw new Error(`Select a ${field} column from this model.`)
    }
  }
  return { dimension: picks.dimension ?? '', measure: picks.measure ?? '', date: picks.date ?? '' }
}

/** Category breakdown: the shape most first dashboards start from. */
export function modelDashboard(entry: DataEntry, dimension: string, measure: string): string {
  const chosen = pick(entry, { dimension, measure }, ['dimension', 'measure'])
  return header(entry, 'dashboard') + `variables:
  category:
    input: text
    label: Category (blank = all)
    default: null
  min_value:
    input: number
    label: Minimum row value
    default: 0
queries:
  summary: |
    with base as (
      select ${columnExpression(chosen.dimension)} as group_key,
             ${columnExpression(chosen.measure)} as measure_value
      from ${entry.expression}
    )
    select group_key, sum(measure_value) as total
    from base
    where {{ filter('group_key', category) }}
      and measure_value >= {{ min_value }}
    group by group_key
charts:
  overview:
    type: bar
    query: summary
    x: group_key
    y: total
    style:
      number_format: number
  details:
    type: table
    query: summary
rows:
  - cols: [overview, details]
`
}

/** KPI row, a trend line and a detail table — the upstream four-part board shape. */
function overview(entry: DataEntry, picks: TemplatePicks): string {
  const chosen = pick(entry, picks, ['date', 'measure', 'dimension'])
  return header(entry, 'overview') + `variables:
  category:
    input: text
    label: Category (blank = all)
    default: null
queries:
  headline: |
    select sum(${columnExpression(chosen.measure)}) as total,
           count(*) as records
    from ${entry.expression}
    where {{ filter(${JSON.stringify(chosen.dimension)}, category) }}
  trend: |
    select date_trunc('month', ${columnExpression(chosen.date)}) as month,
           sum(${columnExpression(chosen.measure)}) as total
    from ${entry.expression}
    where {{ filter(${JSON.stringify(chosen.dimension)}, category) }}
    group by 1
    order by 1
  breakdown: |
    select ${columnExpression(chosen.dimension)} as category,
           sum(${columnExpression(chosen.measure)}) as total
    from ${entry.expression}
    group by 1
    order by 2 desc
charts:
  total_kpi:
    type: kpi
    query: headline
    label: Total ${chosen.measure}
    value: total
    style:
      value:
        format: number
  record_kpi:
    type: kpi
    query: headline
    label: Rows
    value: records
    style:
      value:
        format: integer
  monthly_trend:
    type: line
    query: trend
    title: Monthly total
    x: month
    y: total
    style:
      number_format: number
  category_split:
    type: bar
    query: breakdown
    title: By ${chosen.dimension}
    x: category
    y: total
    style:
      number_format: number
  detail:
    type: table
    query: breakdown
    title: Detail
rows:
  - cols: [total_kpi, record_kpi]
  - cols: [monthly_trend, category_split]
  - detail
`
}

/** Trend over time with an explicit month window. */
function timeseries(entry: DataEntry, picks: TemplatePicks): string {
  const chosen = pick(entry, picks, ['date', 'measure'])
  return header(entry, 'trend') + `variables:
  months:
    input: number
    label: Months to include
    default: 12
queries:
  trend: |
    select date_trunc('month', ${columnExpression(chosen.date)}) as month,
           sum(${columnExpression(chosen.measure)}) as total,
           count(*) as records
    from ${entry.expression}
    group by 1
    order by 1 desc
    limit {{ months }}
charts:
  monthly:
    type: line
    query: trend
    title: ${chosen.measure} by month
    x: month
    y: total
    style:
      number_format: number
  volume:
    type: bar
    query: trend
    title: Rows by month
    x: month
    y: records
  detail:
    type: table
    query: trend
rows:
  - monthly
  - cols: [volume, detail]
`
}

/** Ranked categories — the answer to "which ones are biggest". */
function topValues(entry: DataEntry, picks: TemplatePicks): string {
  const chosen = pick(entry, picks, ['dimension', 'measure'])
  return header(entry, 'top values') + `variables:
  top_n:
    input: number
    label: How many to show
    default: 10
queries:
  ranked: |
    select ${columnExpression(chosen.dimension)} as category,
           sum(${columnExpression(chosen.measure)}) as total
    from ${entry.expression}
    group by 1
    order by 2 desc
    limit {{ top_n }}
charts:
  ranking:
    type: bar
    query: ranked
    title: Top ${chosen.dimension} by ${chosen.measure}
    x: category
    y: total
    style:
      orientation: horizontal
      number_format: number
  detail:
    type: table
    query: ranked
rows:
  - cols: [ranking, detail]
`
}

export const BOARD_TEMPLATES: BoardTemplate[] = [
  { id: 'breakdown', title: 'Category breakdown', fields: ['dimension', 'measure'],
    description: 'A bar chart and a detail table over one grouping column, with category and minimum-value filters.',
    build: (entry, picks) => modelDashboard(entry, picks.dimension ?? '', picks.measure ?? '') },
  { id: 'overview', title: 'Overview: KPIs, trend and detail', fields: ['date', 'dimension', 'measure'],
    description: 'Two KPI cards, a monthly trend, a breakdown and a detail table — the shape most boards start from.',
    build: overview },
  { id: 'timeseries', title: 'Trend over time', fields: ['date', 'measure'],
    description: 'A monthly line, a row-count bar and a table, limited to the most recent months.',
    build: timeseries },
  { id: 'top', title: 'Top values', fields: ['dimension', 'measure'],
    description: 'Ranked horizontal bars and the matching table for the largest categories.',
    build: topValues },
]
