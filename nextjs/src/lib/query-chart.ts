export type ChartKind = "bar" | "line" | "area" | "scatter" | "pie" | "donut" | "kpi" | "table"

export function chartNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function numericChartColumns(data: Record<string, unknown>[], columns: string[]): string[] {
  return columns.filter((column) => {
    const values = data.map((row) => row[column]).filter((value) => value != null)
    return values.length > 0 && values.every((value) => chartNumber(value) !== null)
  })
}

export function chartRows(data: Record<string, unknown>[], columns: string[], valueColumn: string) {
  return data.map((row) => Object.fromEntries(columns.map((column) => {
    const value = row[column]
    if (value == null) return [column, null]
    if (column === valueColumn) return [column, chartNumber(value)]
    if (typeof value === "object") return [column, JSON.stringify(value)]
    return [column, value]
  })))
}

/** Applied to both the embedded preview and downloadable HTML snapshot. */
export function sandboxChartHtml(html: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"
  return html.replace(/<head>/i, `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`)
}
