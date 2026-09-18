import { describe, expect, it } from "vitest"
import { metadataEntries, sqlSuggestions, starterQuery, columnExpression, readDrafts, closeDraft, draftDirty } from "@/lib/explore-data"

const entries = metadataEntries({ models: [{ name: "orders", unique_id: "model.sales.orders", path: "models/orders.sql", columns: [{ name: "amount", data_type: "DECIMAL" }, { name: "order date" }] }], sources: [{ source_name: "raw", table_name: "customers", unique_id: "source.sales.raw.customers", path: "models/sources.yml", columns: [{ name: "customer_id", data_type: "INT" }] }] })

describe("Explore SQL context", () => {
  it("closing an open query does not delete its saved file and keeps a usable tab", () => {
    const state = { active: 'a', drafts: [{ id: 'a', name: 'Sales', sql: 'select 1', savedSql: 'select 1', savedPath: 'analyses/explore/sales.sql' }, { id: 'b', name: 'Other', sql: '' }] }
    expect(draftDirty(state.drafts[0])).toBe(false)
    expect(draftDirty({ ...state.drafts[0], sql: 'select 2' })).toBe(true)
    expect(closeDraft(state, 'a').active).toBe('b')
    expect(closeDraft(closeDraft(state, 'a'), 'b').drafts).toHaveLength(1)
  })
  it("inserts dbt references rather than pretending model names are physical tables", () => {
    expect(entries[0].expression).toBe("{{ ref('sales', 'orders') }}")
    expect(entries[1].expression).toBe("{{ source('raw', 'customers') }}")
    expect(starterQuery(entries[0])).toBe("select *\nfrom {{ ref('sales', 'orders') }}\n")
  })
  it("quotes columns through the active dbt adapter", () => {
    expect(columnExpression('order date')).toBe('{{ adapter.quote("order date") }}')
  })
  it("suggests relations after FROM and JOIN", () => {
    expect(sqlSuggestions("select * from ", entries).map(x => x.label)).toEqual(["orders", "raw.customers"])
    expect(sqlSuggestions("select * from orders o join ", entries)).toHaveLength(2)
  })
  it("resolves aliases in the full query even before FROM", () => {
    const sql = "select o. from {{ ref('sales', 'orders') }} as o"
    expect(sqlSuggestions("select o.", entries, sql).map(x => x.label)).toEqual(["amount", "order date"])
  })
  it("does not invent columns for unknown aliases or unreferenced tables", () => {
    expect(sqlSuggestions("select missing.", entries)).toEqual([])
    expect(sqlSuggestions("select ", entries)).toEqual([])
    expect(sqlSuggestions("select ", entries, "select  from {{ source('raw','customers') }} c").map(x => x.label)).toEqual(["customer_id"])
  })
  it("ignores relations inside comments and strings", () => {
    expect(sqlSuggestions("select ", entries, "select 'from orders' -- join raw.customers\n")).toEqual([])
  })
  it("resolves both sides of joins without aliases", () => {
    expect(sqlSuggestions("select ", entries, "select  from orders join raw.customers on true").map(x => x.label)).toEqual(["amount", "order date", "customer_id"])
  })
  it("handles empty metadata", () => { expect(metadataEntries({})).toEqual([]) })
  it("restores drafts and migrates the existing SQL without losing it", () => {
    expect(readDrafts(null, "select 42").drafts[0].sql).toBe("select 42")
    const stored = { active: "a", drafts: [{ id: "a", name: "Orders", sql: "select 1" }] }
    expect(readDrafts(JSON.stringify(stored), null)).toEqual(stored)
    expect(readDrafts('invalid', "select 99").drafts[0].sql).toBe("select 99")
    expect(readDrafts('{"drafts":[]}', null).drafts).toHaveLength(1)
  })
})
