"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import type { editor } from "monaco-editor"
import { Loader2, Play, Wand2, Plus, X, Save, FolderOpen, Maximize2, Minimize2, MoreHorizontal } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import CodeEditor from "@/components-v2/shared/CodeEditor"
import QueryResultsTable from "@/components-v2/develop/workspace/QueryResultsTable"
import { dbtApi, filesApi } from "@/lib/api"
import { metadataEntries, readDrafts, starterQuery, closeDraft, draftDirty, type DataEntry, type DraftState } from "@/lib/explore-data"
import type { ExploreWorkspaceState } from "@/lib/explore-agent"
import SqlDataBrowser from "./SqlDataBrowser"
import ExecutionEnvironment from "./ExecutionEnvironment"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components-v2/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components-v2/ui/dialog"
import type { BoardAddition } from "./DashboardWorkspace"

const STORAGE_PREFIX = "explore-sql:"
const DRAFT_PREFIX = "explore-drafts:"

interface SqlConsoleProps {
  projectId: string
  /** A file the assistant wrote, to open in a tab. `id` makes a repeat open. */
  openRequest?: { path: string; id: number } | null
  onOpened?: () => void
  /** What is open here, for the assistant to read when it is asked something. */
  onState?: (state: ExploreWorkspaceState) => void
  onAddToDashboard?: (addition: BoardAddition) => void
}

interface Results {
  data: Record<string, unknown>[]
  columns: string[]
  columnTypes?: Record<string, string>
  rowCount: number
  executionTime?: number
  sql: string
}

/**
 * Ad-hoc SQL against the project's own dbt profile.
 *
 * Runs through `dbt show --inline`, which is why it needs no second connection
 * path and why the backend can hold it to read-only SELECT/WITH: the warehouse
 * credentials, macros and target all come from the project's profile.
 */
export default function SqlConsole({
  projectId,
  openRequest,
  onOpened,
  onState,
  onAddToDashboard,
}: SqlConsoleProps): React.ReactElement {
  const [draftState, setDraftState] = useState<DraftState>(() => readDrafts(null, null))
  const [hydrated, setHydrated] = useState(false)
  const draft = draftState.drafts.find(item => item.id === draftState.active) ?? draftState.drafts[0]
  const sql = draft.sql
  const setSql = (value: string) => setDraftState(state => ({ ...state, drafts: state.drafts.map(item => item.id === state.active ? { ...item, sql: value } : item) }))
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const [entries, setEntries] = useState<DataEntry[]>([])
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [catalogAvailable, setCatalogAvailable] = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [browserOpen, setBrowserOpen] = useState(false)
  const requestRevision = useRef(0)
  const [limit, setLimit] = useState(100)
  const [running, setRunning] = useState(false)
  const [formatting, setFormatting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [results, setResults] = useState<Results | null>(null)
  const [target, setTarget] = useState("")
  const [saving, setSaving] = useState(false)
  const [closingId, setClosingId] = useState<string | null>(null)
  const [savedFiles, setSavedFiles] = useState<string[]>([])
  const [savedOpen, setSavedOpen] = useState(false)
  const [savedSearch, setSavedSearch] = useState('')
  const [expandedResults, setExpandedResults] = useState(false)
  const [split, setSplit] = useState(40)
  const splitRef = useRef<HTMLDivElement | null>(null)
  const [pendingChart, setPendingChart] = useState<string | null>(null)
  const [boards, setBoards] = useState<string[]>([])
  const [boardPath, setBoardPath] = useState('')

  // Draft SQL survives a tab switch or reload; it is per project, so two
  // projects do not clobber each other's scratchpad.
  useEffect(() => {
    if (typeof window === "undefined") return
    try {
      setDraftState(readDrafts(window.localStorage.getItem(`${DRAFT_PREFIX}${projectId}`), window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`)))
    } catch { setNotice("Browser storage is unavailable. Drafts will only last for this session.") }
    setHydrated(true)
    return () => { requestRevision.current += 1 }
  }, [projectId])

  useEffect(() => {
    if (!hydrated) return
    try { window.localStorage.setItem(`${DRAFT_PREFIX}${projectId}`, JSON.stringify(draftState)) }
    catch { setNotice("Drafts could not be saved in this browser. Copy your SQL before leaving.") }
  }, [projectId, draftState, hydrated])

  useEffect(() => {
    let cancelled = false
    setMetadataLoading(true)
    setMetadataError(null)
    setEntries([])
    dbtApi.getIntellisense(projectId).then(response => {
      if (cancelled) return
      if (!response.success || response.status === "parse_error") throw new Error("Project metadata could not be read.")
      setEntries(metadataEntries(response))
      setCatalogAvailable(response.catalog_available)
      setGeneratedAt(response.generated_at ?? null)
    }).catch(err => { if (!cancelled) setMetadataError(err instanceof Error ? err.message : "Unable to load metadata") })
      .finally(() => { if (!cancelled) setMetadataLoading(false) })
    return () => { cancelled = true }
  }, [projectId, reload])

  useEffect(() => { onState?.({ queryName: draft.name, sql, target }) }, [onState, draft.name, sql, target])

  // A file the assistant saved, opened in a tab. Reading the path directly
  // means a query written seconds ago needs no listing refresh first.
  const openedRef = useRef(0)
  useEffect(() => {
    if (!hydrated || !openRequest || openedRef.current === openRequest.id) return
    openedRef.current = openRequest.id
    void loadSaved(openRequest.path).finally(() => onOpened?.())
  }, [hydrated, openRequest]) // eslint-disable-line react-hooks/exhaustive-deps

  async function saveDraft() {
    const name = window.prompt('Query name', draft.name)?.trim()
    if (!name) return false
    if (!/^[\w -]{1,80}$/.test(name)) { setNotice('Use 1–80 letters, numbers, spaces, hyphens or underscores.'); return false }
    const path = `analyses/explore/${name}.sql`
    setSaving(true)
    try {
      if (path !== draft.savedPath) {
        const found = await filesApi.search(projectId, name)
        if (found.results.some(file => file.path === path) && !window.confirm(`Replace saved query ${name}?`)) return false
      }
      await filesApi.save(projectId, path, sql)
      setDraftState(state => ({ ...state, drafts: state.drafts.map(item => item.id === draft.id ? { ...item, name, savedPath: path, savedSql: sql } : item) }))
      setNotice(`Saved ${path}`)
      return true
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to save query'); return false }
    finally { setSaving(false) }
  }
  function closeQuery(id: string) {
    const item = draftState.drafts.find(query => query.id === id)
    if (item && draftDirty(item)) { setDraftState(state => ({ ...state, active: id })); setClosingId(id); return }
    setDraftState(state => closeDraft(state, id))
    clearResults()
  }
  async function openSaved() {
    try {
      const response = await filesApi.search(projectId, '.sql')
      setSavedFiles(response.results.filter(file => file.type === 'file' && file.path.startsWith('analyses/explore/') && file.path.endsWith('.sql')).map(file => file.path))
      setSavedOpen(true)
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to list queries') }
  }
  async function loadSaved(path: string) {
    try {
      const existing = draftState.drafts.find(item => item.savedPath === path)
      if (existing) setDraftState(state => ({ ...state, active: existing.id }))
      else {
        const response = await filesApi.read(projectId, path)
        const id = crypto.randomUUID()
        setDraftState(state => ({ active: id, drafts: [...state.drafts, { id, name: path.split('/').pop()!.slice(0, -4), sql: response.content, savedPath: path, savedSql: response.content }] }))
      }
      clearResults(); setSavedOpen(false)
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to open query') }
  }
  async function chooseDashboard(yaml: string) {
    try {
      const response = await filesApi.search(projectId, '.y')
      setBoards(response.results.filter(file => file.type === 'file' && file.path.startsWith('charts/') && /\.ya?ml$/.test(file.path)).map(file => file.path))
      setBoardPath(''); setPendingChart(yaml)
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to list dashboards') }
  }

  const clearResults = () => {
    requestRevision.current += 1
    setResults(null)
    setError(null)
    setRunning(false)
    setFormatting(false)
  }
  const newDraft = (entry?: DataEntry) => {
    if (!hydrated) return
    const id = crypto.randomUUID()
    setDraftState(state => ({ active: id, drafts: [...state.drafts, { id, name: entry?.name ?? `Query ${state.drafts.length + 1}`, sql: entry ? starterQuery(entry) : "" }] }))
    clearResults()
    setBrowserOpen(false)
  }
  const insert = (text: string) => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    if (!editor || !selection) return
    editor.pushUndoStop()
    editor.executeEdits("data-browser", [{ range: selection, text, forceMoveMarkers: true }])
    editor.pushUndoStop()
    editor.focus()
    setBrowserOpen(false)
  }

  const run = useCallback(async () => {
    if (!hydrated || running || formatting || !sql.trim()) return
    const revision = ++requestRevision.current
    setRunning(true)
    setError(null)
    setNotice(null)
    try {
      const response = await dbtApi.query(projectId, sql, limit, target || undefined)
      if (revision !== requestRevision.current) return
      if (!response.success) {
        setResults(null)
        setError(response.error || "Query failed")
        return
      }
      setResults({
        data: response.data ?? [],
        columns: response.columns ?? [],
        columnTypes: response.column_types,
        rowCount: response.row_count ?? (response.data ?? []).length,
        executionTime: response.execution_time,
        sql,
      })
    } catch (err) {
      if (revision !== requestRevision.current) return
      setResults(null)
      setError(err instanceof Error ? err.message : "Query failed")
    } finally {
      if (revision === requestRevision.current) setRunning(false)
    }
  }, [hydrated, running, formatting, limit, projectId, sql, target])

  const format = useCallback(async () => {
    if (!hydrated || running || formatting || !sql.trim()) return
    const revision = requestRevision.current
    setFormatting(true)
    setNotice(null)
    try {
      const response = await dbtApi.format(sql)
      if (revision !== requestRevision.current) return
      if (response.formatted) {
        setSql(response.sql)
      } else {
        // Never overwrite the editor with SQL the formatter could not verify.
        setNotice(response.reason ?? "Could not format this SQL")
      }
    } catch (err) {
      if (revision !== requestRevision.current) return
      setNotice(err instanceof Error ? err.message : "Formatting failed")
    } finally {
      if (revision === requestRevision.current) setFormatting(false)
    }
  }, [hydrated, running, formatting, sql])

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className={`${expandedResults ? 'hidden' : browserOpen ? "h-72 shrink-0 lg:block" : "hidden lg:block"} border-b border-slate-200 lg:h-full lg:w-72 lg:shrink-0 lg:border-b-0 lg:border-r`}>
        <SqlDataBrowser entries={entries} loading={metadataLoading} error={metadataError} catalogAvailable={catalogAvailable} generatedAt={generatedAt} onReload={() => setReload(value => value + 1)} onInsert={insert} onQuery={newDraft} />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 px-2">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-1" aria-label="Open queries">
          {draftState.drafts.map(item => <div key={item.id} className={`flex shrink-0 items-center rounded border ${item.id === draft.id ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-transparent text-slate-500'}`}>
            <button className="max-w-40 truncate px-2 py-1.5 text-xs" aria-pressed={item.id === draft.id} onClick={() => { setDraftState(state => ({ ...state, active: item.id })); clearResults() }}>{item.name}{draftDirty(item) ? ' •' : ''}</button>
            <button className="p-1.5" aria-label={`Close query ${item.name}`} onClick={() => closeQuery(item.id)}><X className="h-3 w-3" /></button>
          </div>)}
        </div>
        <Button size="sm" variant="ghost" aria-label="New query" title="New query" disabled={!hydrated} onClick={() => newDraft()}><Plus className="h-4 w-4" /></Button>
        <Button size="sm" variant="ghost" aria-label="Saved queries" title="Open saved queries" onClick={openSaved}><FolderOpen className="h-4 w-4" /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label="Query actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => { const name = window.prompt('Rename query tab', draft.name)?.trim(); if (name) setDraftState(state => ({ ...state, drafts: state.drafts.map(item => item.id === draft.id ? { ...item, name } : item) })) }}>Rename tab</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { if (!draftState.drafts.some(item => item.id !== draft.id && draftDirty(item)) || window.confirm('Close other queries and discard their unsaved changes? Saved files are kept.')) { setDraftState(state => ({ active: state.active, drafts: state.drafts.filter(item => item.id === state.active) })); clearResults() } }}>Close other tabs</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
        <Button variant="outline" size="sm" className="lg:hidden" aria-expanded={browserOpen} onClick={() => setBrowserOpen(value => !value)}>Data browser</Button>
        <Button size="sm" variant="ghost" aria-label="Save query" title="Save query to project" disabled={saving || !sql.trim()} onClick={saveDraft}><Save className="h-4 w-4" /></Button>
        <Button size="sm" onClick={run} disabled={!hydrated || formatting || running || !sql.trim()}>
          {running ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1.5 h-4 w-4" />
          )}
          Run
        </Button>
        <Button size="sm" variant="ghost" aria-label="Format SQL" title="Format SQL" onClick={format} disabled={formatting || running}>
          {formatting ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Wand2 className="mr-1.5 h-4 w-4" />
          )}
        </Button>
        <label className="ml-1 flex items-center gap-1.5 text-xs text-gray-500">
          Limit
          <input
            type="number"
            min={1}
            max={1000}
            value={limit}
            onChange={(event) =>
              setLimit(Math.max(1, Math.min(1000, Number(event.target.value) || 100)))
            }
            className="h-8 w-16 rounded border border-slate-300 px-2 text-xs"
          />
        </label>
        <ExecutionEnvironment projectId={projectId} value={target} onChange={value => { setTarget(value); clearResults() }} />
        <Button size="sm" variant="ghost" className="ml-auto" aria-label={expandedResults ? 'Restore SQL editor' : 'Expand results'} title={expandedResults ? 'Restore SQL editor' : 'Expand results'} onClick={() => setExpandedResults(value => !value)}>{expandedResults ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</Button>
      </div>

      {notice && (
        <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {notice}
        </p>
      )}

      <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
      <div className={expandedResults ? 'hidden' : 'min-h-24 shrink-0'} style={expandedResults ? undefined : { height: `${split}%` }}>
        <CodeEditor key={draft.id} value={sql} readOnly={!hydrated || formatting} onChange={(value) => setSql(value ?? "")} onRun={run} onPreview={run} dataEntries={entries} onEditorReady={editor => { editorRef.current = editor }} />
      </div>
      {!expandedResults && <div role="separator" aria-label="Resize SQL and results" aria-orientation="horizontal" aria-valuenow={split} aria-valuemin={15} aria-valuemax={75} tabIndex={0} className="h-2 shrink-0 cursor-row-resize touch-none border-y border-slate-200 bg-slate-50 hover:bg-blue-100" onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSplit(value => Math.max(15, Math.min(75, value + (event.key === 'ArrowUp' ? -5 : 5)))) } }} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = splitRef.current?.getBoundingClientRect(); if (rect) setSplit(Math.max(15, Math.min(75, 100 * (event.clientY - rect.top) / rect.height))) }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <QueryResultsTable data={[]} columns={[]} error={error} />
        ) : results ? (
          <QueryResultsTable
            data={results.data}
            columns={results.columns}
            columnTypes={results.columnTypes}
            rowCount={results.rowCount}
            executionTime={results.executionTime}
            onChartView={() => setExpandedResults(true)}
            onAddToDashboard={onAddToDashboard ? chooseDashboard : undefined}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-gray-500">
            {running ? "Running query…" : "Run a SELECT to see results here."}
          </div>
        )}
      </div>
      </div>
      </div>
      <Dialog open={!!closingId} onOpenChange={open => { if (!open) setClosingId(null) }}><DialogContent><DialogHeader><DialogTitle>Save query before closing?</DialogTitle><DialogDescription>Your query has unsaved changes. Saved project files are not deleted when closing tabs.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" disabled={saving} onClick={() => setClosingId(null)}>Cancel</Button><Button variant="outline" disabled={saving} onClick={() => { if (closingId) setDraftState(state => closeDraft(state, closingId)); setClosingId(null); clearResults() }}>Discard changes</Button><Button disabled={saving} onClick={async () => { if (await saveDraft()) { if (closingId) setDraftState(state => closeDraft(state, closingId)); setClosingId(null); clearResults() } }}>Save and close</Button></div></DialogContent></Dialog>
      <Dialog open={savedOpen} onOpenChange={setSavedOpen}><DialogContent><DialogHeader><DialogTitle>Saved queries</DialogTitle><DialogDescription>Files in analyses/explore. Closing a tab does not delete these files.</DialogDescription></DialogHeader>
        <input aria-label="Search saved queries" placeholder="Search queries…" className="rounded border p-2 text-sm" value={savedSearch} onChange={event => setSavedSearch(event.target.value)} />
        <div className="max-h-72 overflow-auto">{savedFiles.filter(path => path.toLowerCase().includes(savedSearch.toLowerCase())).map(path => <div className="flex items-center justify-between border-b py-2" key={path}><button className="truncate text-sm text-blue-700" onClick={() => loadSaved(path)}>{path.split('/').pop()}</button><Button size="sm" variant="ghost" aria-label={`Delete ${path}`} onClick={async () => { if (!window.confirm(`Delete ${path} from the project? Open tabs are kept.`)) return; try { await filesApi.delete(projectId, path); setSavedFiles(files => files.filter(file => file !== path)) } catch (err) { setNotice(String(err)) } }}>Delete</Button></div>)}{!savedFiles.length && <p className="text-sm text-slate-500">No saved queries. Use Save query first.</p>}</div>
      </DialogContent></Dialog>
      <Dialog open={!!pendingChart} onOpenChange={open => { if (!open) setPendingChart(null) }}><DialogContent><DialogHeader><DialogTitle>Add chart to dashboard</DialogTitle><DialogDescription>Add the query and chart definition, so the dashboard can refresh its data.</DialogDescription></DialogHeader>
        <select aria-label="Destination dashboard" className="rounded border p-2" value={boardPath} onChange={event => setBoardPath(event.target.value)}><option value="">New dashboard</option>{boards.map(path => <option key={path}>{path}</option>)}</select>
        <Button onClick={() => { if (pendingChart && results) onAddToDashboard?.({ chartYaml: pendingChart, sql: results.sql, columns: results.columns, path: boardPath, target }); setPendingChart(null) }}>Add and open dashboard</Button>
      </DialogContent></Dialog>
    </div>
  )
}
