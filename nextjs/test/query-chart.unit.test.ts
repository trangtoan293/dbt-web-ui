import { describe, expect, it } from "vitest"
import { chartNumber, chartRows, numericChartColumns, sandboxChartHtml } from "@/lib/query-chart"

describe("query chart data", () => {
  it("recognizes decimal values without converting blanks, booleans or objects to zero", () => {
    expect(chartNumber("12.50")).toBe(12.5)
    expect(chartNumber("-2e3")).toBe(-2000)
    for (const value of ["", " ", true, null, {}, "Infinity", Infinity, "2026-01-01"]) expect(chartNumber(value)).toBeNull()
  })
  it("uses all returned rows when identifying numeric fields", () => {
    expect(numericChartColumns([{ a: 1, b: "2", c: null }, { a: "text", b: "3.5", c: null }], ["a", "b", "c"])).toEqual(["b"])
  })
  it("only coerces the selected measure and preserves null and category IDs", () => {
    expect(chartRows([{ id: "001", amount: "12.5", missing: null, metadata: { x: 1 } }], ["id", "amount", "missing", "metadata"], "amount")).toEqual([
      { id: "001", amount: 12.5, missing: null, metadata: '{"x":1}' },
    ])
  })
  it("restricts networking in both preview and exported HTML", () => {
    const html = sandboxChartHtml("<!DOCTYPE html><html><head><title>Chart</title></head></html>")
    expect(html).toContain("connect-src 'none'")
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<title>"))
  })
})
