import type { DbtIntellisenseColumn, DbtIntellisenseModel, DbtIntellisenseSource } from "@/lib/api"

export interface DataEntry {
  id: string
  name: string
  kind: "model" | "source"
  description?: string | null
  path: string
  columns: DbtIntellisenseColumn[]
  expression: string
}

const literal = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
export function metadataEntries(data: { models?: DbtIntellisenseModel[]; sources?: DbtIntellisenseSource[] }): DataEntry[] {
  return [
    ...(data.models ?? []).map(model => ({ id: model.unique_id, name: model.name, kind: "model" as const,
      description: model.description, path: model.path, columns: model.columns ?? [],
      expression: `{{ ref(${literal(model.unique_id.split(".")[1])}, ${literal(model.name)}) }}` })),
    ...(data.sources ?? []).map(source => ({ id: source.unique_id, name: `${source.source_name}.${source.table_name}`, kind: "source" as const,
      description: source.description, path: source.path, columns: source.columns ?? [],
      expression: `{{ source(${literal(source.source_name)}, ${literal(source.table_name)}) }}` })),
  ]
}

export const columnExpression = (name: string) => `{{ adapter.quote(${JSON.stringify(name)}) }}`
export const starterQuery = (entry: DataEntry) => `select *\nfrom ${entry.expression}\n`

export interface SqlSuggestion { label: string; insertText: string; detail: string; kind: "table" | "column" }

// A conservative completion helper, not a SQL parser. Supports dbt references,
// simple relations and aliases; unknown aliases get no speculative columns.
function sqlContext(sql: string) {
  return sql.replace(/\{\{[\s\S]*?\}\}|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g,
    token => token.startsWith("{{") ? token : " ".repeat(token.length))
}

export function sqlSuggestions(beforeCursor: string, entries: DataEntry[], fullSql = beforeCursor): SqlSuggestion[] {
  const before = sqlContext(beforeCursor)
  if (/\b(?:from|join)\s+[\w.]*$/i.test(before)) {
    return entries.map(entry => ({ label: entry.name, insertText: entry.expression, detail: `${entry.kind} · ${entry.path}`, kind: "table" }))
  }
  const context = sqlContext(fullSql)
  const relations = [...context.matchAll(/\b(?:from|join)\s+(\{\{[\s\S]*?\}\}|[\w.]+)(?:\s+(?:as\s+)?((?!(?:where|join|left|right|inner|outer|full|cross|on|group|order|limit|having|union)\b)[a-z_]\w*))?/gi)]
  const qualifier = before.match(/([a-z_]\w*)\.\w*$/i)?.[1]?.toLowerCase()
  const keywords = new Set(["where", "join", "left", "right", "inner", "outer", "full", "cross", "on", "group", "order", "limit", "having", "union"])
  const matches = relations.flatMap(([, relation, alias]) => {
    const normalize = (value: string) => value.replace(/\s/g, "").replace(/"/g, "'").toLowerCase()
    const entry = entries.find(item => normalize(item.expression) === normalize(relation)
      || (item.kind === "model" && normalize(relation) === normalize(`{{ ref(${literal(item.name)}) }}`))
      || item.name.toLowerCase() === relation.toLowerCase())
    if (!entry) return []
    const validAlias = alias && !keywords.has(alias.toLowerCase()) ? alias.toLowerCase() : undefined
    if (qualifier && qualifier !== validAlias && qualifier !== entry.name.toLowerCase()) return []
    return entry.columns.map(column => ({ label: column.name, insertText: columnExpression(column.name),
      detail: `${entry.name} · ${column.data_type || "Type unavailable"}${column.description ? ` · ${column.description}` : ""}`, kind: "column" as const }))
  })
  return matches.filter((item, index) => matches.findIndex(other => other.label === item.label) === index)
}

export interface SqlDraft { id: string; name: string; sql: string; savedPath?: string; savedSql?: string }
export interface DraftState { active: string; drafts: SqlDraft[] }
export const draftDirty = (draft: SqlDraft) => draft.savedPath ? draft.sql !== draft.savedSql : !!draft.sql.trim()
export function closeDraft(state: DraftState, id: string): DraftState {
  const remaining = state.drafts.filter(draft => draft.id !== id)
  if (!remaining.length) return { active: 'initial', drafts: [{ id: 'initial', name: 'Query 1', sql: '' }] }
  return { active: state.active === id ? remaining[remaining.length - 1].id : state.active, drafts: remaining }
}
export function readDrafts(saved: string | null, legacy: string | null): DraftState {
  try {
    const value = JSON.parse(saved ?? "null")
    if (value && Array.isArray(value.drafts) && value.drafts.length && value.drafts.every((draft: SqlDraft) =>
      draft && typeof draft.id === "string" && typeof draft.name === "string" && typeof draft.sql === "string"
      && (draft.savedPath === undefined || typeof draft.savedPath === 'string')
      && (draft.savedSql === undefined || typeof draft.savedSql === 'string'))) {
      return { drafts: value.drafts, active: value.drafts.some((draft: SqlDraft) => draft.id === value.active) ? value.active : value.drafts[0].id }
    }
  } catch { /* Keep legacy drafts if storage is malformed. */ }
  return { active: "initial", drafts: [{ id: "initial", name: "Query 1", sql: legacy ?? "select 1 as answer" }] }
}
