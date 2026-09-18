import { describe, expect, it } from 'vitest'
import { CHART_TYPES, acceptsSeries, boardDiagnostics, chartPayload, chartReady, diagnosticText, emptyChartDraft, suggestChart } from '@/lib/board'

describe('board diagnostics', () => {
  it('reads the engine diagnostics out of a 422 board response', () => {
    const error = { message: 'failed', status: 422, details: { detail: { message: 'failed', diagnostics: [{ message: 'bad field', level: 'error', line: 7 }] } } }
    expect(boardDiagnostics(error)).toHaveLength(1)
    expect(boardDiagnostics({ message: 'network down' })).toEqual([])
    expect(boardDiagnostics(undefined)).toEqual([])
  })

  it('labels a diagnostic with the line and chart it belongs to', () => {
    expect(diagnosticText({ message: 'y is empty', level: 'warning', line: 12, chart: 'trend' })).toBe('Line 12 · chart trend: y is empty')
    expect(diagnosticText({ message: 'board is empty', level: 'error' })).toBe('board is empty')
  })
})

describe('chart builder surface', () => {
  it('asks for the channels each type actually needs', () => {
    const channels = (type: string) => CHART_TYPES.find(item => item.value === type)!.channels.map(channel => channel.key)
    expect(channels('table')).toEqual([])
    expect(channels('kpi')).toEqual(['y'])
    expect(channels('histogram')).toEqual(['x'])
    expect(channels('heatmap')).toEqual(['x', 'y', 'color'])
    expect(channels('bar')).toEqual(['x', 'y'])
  })

  it('offers an optional series only where a colour splits the marks', () => {
    expect(CHART_TYPES.filter(item => acceptsSeries(item.value)).map(item => item.value)).toEqual(['bar', 'line', 'area', 'scatter'])
    expect(acceptsSeries('pie')).toBe(false)
  })
})

describe('shared chart draft', () => {
  const draft = { ...emptyChartDraft(), type: 'bar', title: 'Revenue', format: 'currency' }

  it('seeds the dimension from a text column and the measure from a numeric one', () => {
    const seeded = suggestChart(['month', 'revenue'], ['revenue'], draft)
    expect(seeded.fields).toMatchObject({ x: 'month', y: 'revenue' })
    expect(chartReady(seeded, ['month', 'revenue'])).toBe(true)
    expect(chartReady(seeded, ['month'])).toBe(false)
  })

  it('sends only the channels the chosen type owns', () => {
    const seeded = suggestChart(['month', 'revenue'], ['revenue'], draft)
    expect(chartPayload(seeded)).toEqual({ type: 'bar', title: 'Revenue', number_format: 'currency', x: 'month', y: 'revenue' })
    expect(chartPayload({ ...seeded, type: 'kpi' })).toEqual({ type: 'kpi', title: 'Revenue', number_format: 'currency', y: 'revenue' })
    expect(chartPayload({ ...seeded, type: 'table', format: '' })).toEqual({ type: 'table', title: 'Revenue', number_format: undefined })
  })

  it('adds a series only where the type splits its marks by colour', () => {
    const seeded = { ...suggestChart(['month', 'revenue', 'region'], ['revenue'], draft), series: 'region' }
    expect(chartPayload(seeded).color).toBe('region')
    // A pie takes its category on x; the runner turns that into colour and theta.
    expect(chartPayload({ ...seeded, type: 'pie' })).toMatchObject({ x: 'month', y: 'revenue' })
    expect(chartPayload({ ...seeded, type: 'pie' }).color).toBeUndefined()
  })
})
