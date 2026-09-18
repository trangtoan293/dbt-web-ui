"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, Database, Plus, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { columnExpression, type DataEntry } from "@/lib/explore-data"

interface Props {
  entries: DataEntry[]
  loading: boolean
  error: string | null
  catalogAvailable: boolean
  generatedAt?: string | null
  onReload: () => void
  onInsert: (text: string) => void
  onQuery: (entry: DataEntry) => void
}

export default function SqlDataBrowser({ entries, loading, error, catalogAvailable, generatedAt, onReload, onInsert, onQuery }: Props) {
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null)
  const needle = query.trim().toLowerCase()
  const filtered = entries.filter(entry => `${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(needle)
    || entry.columns.some(column => column.name.toLowerCase().includes(needle)))

  return <section aria-label="Project data browser" className="flex h-full min-h-0 flex-col bg-slate-50/60">
    <div className="flex items-center justify-between px-3 pt-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Database className="h-4 w-4 text-blue-600" />Data browser</h2>
      <Button variant="ghost" size="sm" aria-label="Reload metadata" onClick={onReload} disabled={loading}><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></Button>
    </div>
    <div className="relative m-3 mt-2"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" /><input aria-label="Search tables and columns" placeholder="Find a model, source or column…" value={query} onChange={event => setQuery(event.target.value)} className="h-9 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-xs" /></div>
    <div className="border-b border-slate-200 px-3 pb-3 text-[11px] text-slate-500">
      Project metadata · not a live warehouse inventory
      {generatedAt && <span className="block">Manifest: {new Date(generatedAt).toLocaleString()}</span>}
      {!catalogAvailable && !loading && <p className="mt-1 text-amber-700">Some types may be unavailable. Generate Docs to enrich metadata.</p>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-2">
      {loading ? <p role="status" className="p-3 text-xs text-slate-500">Loading project metadata…</p>
        : error ? <p role="alert" className="p-3 text-xs text-red-700">{error} Use Reload metadata to retry.</p>
        : entries.length === 0 ? <p className="p-3 text-xs text-slate-500">No metadata yet. Run dbt parse or Generate Docs, then reload.</p>
        : filtered.length === 0 ? <p className="p-3 text-xs text-slate-500">No matching models, sources or columns.</p>
        : (["model", "source"] as const).map(kind => <div key={kind} className="mb-3">
          <h3 className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{kind === "model" ? "Models" : "Sources"} · {filtered.filter(entry => entry.kind === kind).length}</h3>
          {filtered.filter(entry => entry.kind === kind).map(entry => {
            const open = expanded === entry.id || !!needle
            return <div key={entry.id} className="mb-1 overflow-hidden rounded-lg border border-transparent bg-white hover:border-slate-200">
              <button className="flex w-full items-center gap-1.5 p-2 text-left text-xs font-medium text-slate-800" aria-expanded={open} onClick={() => { setExpanded(open ? null : entry.id); setSelectedColumn(null) }}>
                {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}<span className="truncate" title={entry.name}>{entry.name}</span><span className="ml-auto text-[10px] text-slate-400">{entry.columns.length}</span>
              </button>
              {open && <div className="border-t border-slate-100 px-2 pb-2">
                <p className="my-2 break-words text-[11px] text-slate-500">{entry.description || "No description recorded."}</p>
                <p className="mb-2 break-all font-mono text-[10px] text-slate-400">{entry.path}</p>
                <div className="mb-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => onQuery(entry)}>Query this table</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" aria-label={`Insert reference to ${entry.name}`} onClick={() => onInsert(entry.expression)}>Insert reference</Button>
                </div>
                {!entry.columns.length && <p className="py-2 text-[11px] text-slate-500">No columns recorded. Generate Docs to discover columns.</p>}
                {entry.columns.map(column => <div key={column.name} className="border-t border-slate-100">
                  <div className="flex items-center gap-1 py-1">
                    <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedColumn(selectedColumn === `${entry.id}:${column.name}` ? null : `${entry.id}:${column.name}`)} aria-expanded={selectedColumn === `${entry.id}:${column.name}`}>
                      <span className="block truncate font-mono text-[11px] text-slate-700" title={column.name}>{column.name}</span><span className="block truncate text-[10px] text-slate-400">{column.data_type || "Type unavailable"}</span>
                    </button>
                    <button className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600" aria-label={`Insert column ${column.name}`} title="Insert column at cursor" onClick={() => onInsert(columnExpression(column.name))}><Plus className="h-3.5 w-3.5" /></button>
                  </div>
                  {selectedColumn === `${entry.id}:${column.name}` && <p className="pb-2 text-[11px] text-slate-500">{column.description || "No description recorded."}</p>}
                </div>)}
              </div>}
            </div>
          })}
        </div>)}
    </div>
  </section>
}
