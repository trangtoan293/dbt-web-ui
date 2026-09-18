"use client"

import React, { useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import { BookOpen, ChartColumn, CheckCircle2, Code2, Database, FileText, MoreHorizontal, Play, Plus, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components-v2/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components-v2/ui/dropdown-menu'
import CodeEditor from '@/components-v2/shared/CodeEditor'
import { dbtApi, filesApi } from '@/lib/api'
import { apiClient } from '@/lib/api/client'
import { sandboxChartHtml } from '@/lib/query-chart'
import { metadataEntries, type DataEntry } from '@/lib/explore-data'
import { boardDiagnostics, diagnosticText, type BoardDiagnostic, type BoardOutline, type BoardVariable } from '@/lib/board'
import ExecutionEnvironment from './ExecutionEnvironment'
import DashboardGuide from './DashboardGuide'
import AddChartDialog from './AddChartDialog'
import SaveDashboardDialog from './SaveDashboardDialog'
import SqlDataBrowser from './SqlDataBrowser'

const Divider = () => <span aria-hidden className="mx-0.5 h-5 w-px bg-slate-200" />

export interface BoardAddition { chartYaml: string; sql: string; columns: string[]; path: string; target: string }
interface Validation { valid: boolean; variables?: Record<string, BoardVariable>; outline?: BoardOutline; diagnostics?: { errors?: BoardDiagnostic[]; warnings?: BoardDiagnostic[] } }
interface Rendered { html: string; warnings: BoardDiagnostic[]; variables: Record<string, BoardVariable>; outline: BoardOutline; query_count: number }

const DRAFT_PREFIX = 'explore-board:'
const EMPTY = `# A new dashboard. Add chart writes the query and the chart for you,
# or start from Samples and guide.
`

export default function DashboardWorkspace({ projectId, addition, onConsumed, onDirty }: {
  projectId: string; addition: BoardAddition | null; onConsumed: () => void; onDirty: (dirty: boolean) => void
}) {
  const [yaml, setYaml] = useState(EMPTY)
  const [baseline, setBaseline] = useState(EMPTY)
  const [path, setPath] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [html, setHtml] = useState('')
  const [stale, setStale] = useState(false)
  const [message, setMessage] = useState('New dashboard · Add chart builds the first query and chart for you.')
  const [diagnostics, setDiagnostics] = useState<BoardDiagnostic[]>([])
  const [busy, setBusy] = useState(false)
  const [showYaml, setShowYaml] = useState(true)
  const [guideOpen, setGuideOpen] = useState(false)
  const [chartOpen, setChartOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [variables, setVariables] = useState<Record<string, BoardVariable>>({})
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [outline, setOutline] = useState<BoardOutline | null>(null)
  const [entries, setEntries] = useState<DataEntry[]>([])
  const [metadataLoading, setMetadataLoading] = useState(true)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [catalogAvailable, setCatalogAvailable] = useState(true)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [hydrated, setHydrated] = useState(false)
  const dirty = yaml !== baseline
  const empty = !yaml.replace(/^\s*#.*$/gm, '').trim()
  const additionRef = useRef<BoardAddition | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const endpoint = `/charts/${projectId}/board`

  async function refreshFiles() {
    const response = await filesApi.search(projectId, '.y')
    setFiles(response.results.filter(file => file.path.startsWith('charts/') && /\.ya?ml$/.test(file.path)).map(file => file.path))
  }
  useEffect(() => { refreshFiles().catch(error => setMessage(error.message)) }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])

  // Unsaved YAML survives a tab switch or a reload, the way SQL drafts do.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const saved = JSON.parse(window.localStorage.getItem(`${DRAFT_PREFIX}${projectId}`) ?? 'null')
      if (saved && typeof saved.yaml === 'string' && typeof saved.baseline === 'string' && typeof saved.path === 'string') {
        setYaml(saved.yaml); setBaseline(saved.baseline); setPath(saved.path)
        if (saved.yaml !== saved.baseline) setMessage('Restored an unsaved draft of this dashboard.')
      }
    } catch { setMessage('Browser storage is unavailable. This draft will only last for this session.') }
    setHydrated(true)
  }, [projectId])
  useEffect(() => {
    if (!hydrated) return
    try { window.localStorage.setItem(`${DRAFT_PREFIX}${projectId}`, JSON.stringify({ yaml, baseline, path })) } catch { /* storage full or blocked */ }
  }, [hydrated, projectId, yaml, baseline, path])

  useEffect(() => {
    let cancelled = false
    setMetadataLoading(true); setMetadataError(null); setEntries([])
    dbtApi.getIntellisense(projectId).then(response => {
      if (cancelled) return
      if (!response.success || response.status === 'parse_error') throw new Error('Project metadata could not be read.')
      setEntries(metadataEntries(response)); setCatalogAvailable(response.catalog_available); setGeneratedAt(response.generated_at ?? null)
    }).catch(error => { if (!cancelled) setMetadataError(error instanceof Error ? error.message : 'Unable to load metadata') })
      .finally(() => { if (!cancelled) setMetadataLoading(false) })
    return () => { cancelled = true }
  }, [projectId, reload])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null
      if (dirty && link && link.target !== '_blank' && !event.metaKey && !event.ctrlKey && link.href !== window.location.href && !window.confirm('Leave this page and discard unsaved dashboard edits?')) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', navigate, true)
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', navigate, true) }
  }, [dirty])

  useEffect(() => {
    if (!addition || additionRef.current === addition) return
    additionRef.current = addition
    if (dirty && !window.confirm('Discard unsaved dashboard edits before adding this chart?')) { onConsumed(); return }
    setBusy(true)
    ;(async () => {
      const existing = addition.path ? (await filesApi.read(projectId, addition.path)).content : ''
      const result = await apiClient.post<{ yaml: string }>(`${endpoint}/compose`, { yaml: existing, chart_yaml: addition.chartYaml, sql: addition.sql, columns: addition.columns })
      setYaml(result.yaml); setBaseline(existing); setPath(addition.path); setTarget(addition.target)
      setStale(true); setShowYaml(true); setMessage('Chart added with refreshable SQL. Save this dashboard to reuse it.')
    })().catch(error => setMessage(error.message)).finally(() => { setBusy(false); onConsumed() })
  }, [addition, projectId, endpoint, dirty, onConsumed])

  /** Editing never discards the preview or the filters already entered; it marks them out of date. */
  function edit(content: string) { setYaml(content); setDiagnostics([]); if (html) setStale(true) }

  /** `pristine` boards open unmodified; a generated template counts as unsaved work. */
  function load(content: string, file: string, note: string, pristine: boolean) {
    setYaml(content); setBaseline(pristine ? content : ''); setPath(file)
    setHtml(''); setStale(false); setVariables({}); setValues({}); setOutline(null); setDiagnostics([]); setMessage(note)
  }

  function insert(text: string) {
    const instance = editorRef.current
    const selection = instance?.getSelection()
    if (!instance || !selection) return
    instance.pushUndoStop()
    instance.executeEdits('data-browser', [{ range: selection, text, forceMoveMarkers: true }])
    instance.pushUndoStop()
    instance.focus()
    setBrowserOpen(false)
  }

  function reveal(line?: number | null) {
    if (!line || !editorRef.current) return
    setShowYaml(true)
    editorRef.current.revealLineInCenter(line)
    editorRef.current.setPosition({ lineNumber: line, column: 1 })
    editorRef.current.focus()
  }

  async function open(file: string) {
    if (dirty && !window.confirm('Discard unsaved dashboard edits?')) return
    setBusy(true)
    try {
      const content = file ? (await filesApi.read(projectId, file)).content : EMPTY
      load(content, file, file || 'New dashboard · Add chart builds the first query and chart for you.', true)
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }

  function report(items: BoardDiagnostic[], next: { outline?: BoardOutline; variables?: Record<string, BoardVariable> }) {
    setDiagnostics(items)
    if (next.outline) setOutline(next.outline)
    const spec = next.variables
    if (!spec) return
    setVariables(spec)
    // A renamed or removed filter must not be posted back with the next render.
    setValues(current => Object.fromEntries(Object.entries(current).filter(([name]) => name in spec)))
  }

  async function validate() {
    if (empty) { setMessage('This dashboard is empty. Add chart writes its first query and chart.'); return }
    setBusy(true)
    try {
      const result = await apiClient.post<Validation>(`${endpoint}/validate`, { yaml })
      report([...(result.diagnostics?.errors ?? []), ...(result.diagnostics?.warnings ?? [])],
        { outline: result.outline, variables: result.valid ? result.variables ?? {} : undefined })
      setMessage(result.valid ? 'Valid dashboard. Preview / Refresh executes each named SQL query (up to 1,000 rows each).'
        : 'Invalid dashboard. Fix the reported lines, then validate again.')
    } catch (error) { setDiagnostics(boardDiagnostics(error)); setMessage((error as Error).message) } finally { setBusy(false) }
  }

  async function render() {
    if (empty) { setMessage('This dashboard is empty. Add chart writes its first query and chart.'); return }
    setBusy(true)
    try {
      // One round trip: the renderer reports its own errors, filters and outline.
      const result = await apiClient.post<Rendered>(`${endpoint}/render`, { yaml, variables: values, target })
      report(result.warnings ?? [], result)
      setHtml(sandboxChartHtml(result.html)); setStale(false)
      setMessage(result.warnings?.length
        ? `Preview refreshed with ${result.warnings.length} warning(s) · ${result.query_count} queries executed.`
        : `Preview refreshed · ${result.query_count} queries executed. Filters apply on the next Refresh.`)
    } catch (error) { setDiagnostics(boardDiagnostics(error)); setMessage((error as Error).message) } finally { setBusy(false) }
  }

  async function writeTo(destination: string) {
    setBusy(true)
    try {
      await filesApi.save(projectId, destination, yaml)
      setPath(destination); setBaseline(yaml)
      setMessage(`Saved ${destination} · Project file, not automatically committed to Git.`)
      await refreshFiles()
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }

  const save = () => path ? writeTo(path) : setSaveOpen(true)

  return <section className="flex h-full min-h-0 flex-col" aria-label="Dashboard workspace">
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
      {/* Which dashboard is open, and whether it is saved, is stated rather than implied. */}
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="max-w-56 truncate font-medium text-slate-800" title={path || 'Not saved yet'}>{path ? path.replace(/^charts\//, '') : 'Untitled dashboard'}</span>
        {dirty ? <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Unsaved</span>
          : path && <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">Saved</span>}
      </span>
      <Divider />
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => open('')}>New</Button>
      <select aria-label="Open a saved dashboard" className="h-8 max-w-44 rounded-md border border-slate-200 px-1.5 text-xs text-slate-600" value="" disabled={busy || !files.length}
        onChange={event => { if (event.target.value) open(event.target.value) }}>
        <option value="">{files.length ? 'Open…' : 'No saved dashboards'}</option>
        {files.map(file => <option key={file} value={file}>{file.replace(/^charts\//, '')}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy} onClick={save}><Save />Save{dirty && <span aria-hidden className="text-amber-600">•</span>}</Button>
      <Divider />
      <Button size="sm" disabled={busy} onClick={render}>{busy ? 'Working…' : html ? <><RefreshCw />Refresh</> : <><Play />Preview</>}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setChartOpen(true)}><Plus />Add chart</Button>
      <Divider />
      <Button size="sm" variant="ghost" className="px-2" aria-label="Data" aria-pressed={browserOpen} title="Project models, sources and columns" onClick={() => setBrowserOpen(!browserOpen)}><Database className={browserOpen ? 'text-blue-700' : ''} /></Button>
      <Button size="sm" variant="ghost" className="px-2" aria-label="YAML" aria-pressed={showYaml} title="Show or hide the YAML editor" onClick={() => setShowYaml(!showYaml)}><Code2 className={showYaml ? 'text-blue-700' : ''} /></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="px-2" aria-label="More dashboard actions" disabled={busy}><MoreHorizontal /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={validate}><CheckCircle2 className="mr-2 h-4 w-4" />Validate</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSaveOpen(true)}><Save className="mr-2 h-4 w-4" />Save as…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setGuideOpen(true)}><BookOpen className="mr-2 h-4 w-4" />Samples and guide</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto"><ExecutionEnvironment disabled={busy} projectId={projectId} value={target} onChange={value => { setTarget(value); setStale(!!html) }} /></div>
    </div>
    <p role="status" className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap border-b px-3 py-1.5 text-xs text-slate-600">{message}{!path && <button className="ml-2 text-blue-700 underline" onClick={() => setGuideOpen(true)}>Start with a model →</button>}</p>
    {diagnostics.length > 0 && <ul role="alert" className="max-h-32 shrink-0 overflow-auto border-b bg-slate-50 px-3 py-1.5 text-xs">
      {diagnostics.map((item, index) => <li key={index} className={item.level === 'error' ? 'text-red-700' : 'text-amber-700'}>
        <button className="text-left underline-offset-2 hover:underline" onClick={() => reveal(item.line)}>{diagnosticText(item)}</button>
        {item.fix && <span className="block pl-3 text-slate-600">Fix: {item.fix}</span>}
      </li>)}
    </ul>}
    {Object.keys(variables).length > 0 && <fieldset disabled={busy} className="flex shrink-0 flex-wrap items-center gap-3 border-b p-2">{Object.entries(variables).map(([name, spec]) => {
      const value = (Object.hasOwn(values, name) ? values[name] : spec.default) ?? ''
      const update = (next: unknown) => { setValues(current => ({ ...current, [name]: Array.isArray(next) && next.includes(undefined) ? [] : next ?? null })); setStale(!!html) }
      return <label key={name} className="text-xs" title={spec.notes}>{spec.label || name}{spec.options?.static ? <select className="ml-2 rounded border" multiple={spec.input === 'multiselect'} value={spec.input === 'multiselect' ? (Array.isArray(value) ? value.map(String) : []) : String(value)} onChange={event => update(spec.input === 'multiselect' ? Array.from(event.target.selectedOptions, option => spec.options!.static!.find(item => String(item) === option.value)) : spec.options!.static!.find(item => String(item) === event.target.value))}><option value="">All</option>{spec.options.static.map((option, i) => <option key={i} value={String(option)}>{String(option)}</option>)}</select> : <input className="ml-2 rounded border px-2" type={spec.input === 'checkbox' ? 'checkbox' : spec.input === 'number' ? 'number' : spec.input === 'date' ? 'date' : 'text'} checked={spec.input === 'checkbox' ? Boolean(value) : undefined} value={spec.input === 'checkbox' ? undefined : String(value)} onChange={event => update(spec.input === 'checkbox' ? event.target.checked : spec.input === 'number' && event.target.value ? Number(event.target.value) : event.target.value)} />}</label>
    })}{stale && <span className="text-xs text-amber-700">Showing the previous render · Refresh to apply.</span>}</fieldset>}
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {browserOpen && <div className="h-64 shrink-0 border-b lg:h-full lg:w-72 lg:border-b-0 lg:border-r">
        <SqlDataBrowser entries={entries} loading={metadataLoading} error={metadataError} catalogAvailable={catalogAvailable} generatedAt={generatedAt}
          onReload={() => setReload(value => value + 1)} onInsert={insert}
          onQuery={entry => insert(`  ${entry.name.replace(/\W/g, '_')}: |\n    select *\n    from ${entry.expression}\n`)} />
      </div>}
      {showYaml && <div className={`min-h-48 min-w-0 border-r ${html || empty || !showYaml ? 'lg:w-2/5 lg:max-w-[520px]' : 'w-full'} flex-1`}>
        <CodeEditor language="yaml" value={yaml} onChange={value => edit(value ?? '')} readOnly={busy} dataEntries={entries}
          onEditorReady={instance => { editorRef.current = instance }} onSave={save} onPreview={render} onRun={render} />
      </div>}
      {html ? <iframe title="Dashboard preview" srcDoc={html} sandbox="allow-scripts" referrerPolicy="no-referrer" className={`min-h-64 min-w-0 flex-1 border-0 ${stale ? 'opacity-60' : ''}`} />
        : (empty || !showYaml) && <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <ChartColumn className="h-8 w-8 text-slate-300" />
          {empty ? <>
            <p className="text-sm text-slate-600">This dashboard is empty.</p>
            <p className="max-w-sm text-xs text-slate-500">Add chart runs a query against one of your models and writes both the query and the chart into the YAML. Or copy a ready-made board from Samples and guide.</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setChartOpen(true)}><Plus />Add chart</Button>
              <Button size="sm" variant="outline" onClick={() => setGuideOpen(true)}><BookOpen />Samples and guide</Button>
            </div>
          </> : <p className="text-sm text-slate-500">Click Preview to render your dashboard.</p>}
        </div>}
    </div>
    <AddChartDialog projectId={projectId} open={chartOpen} onOpenChange={setChartOpen} yaml={yaml} target={target} values={values} outline={outline} entries={entries}
      onInserted={(next, note) => { setYaml(next); setStale(!!html); setDiagnostics([]); setShowYaml(true); setMessage(note) }} />
    <SaveDashboardDialog open={saveOpen} onOpenChange={setSaveOpen} files={files} suggestion={path.replace(/^charts\//, '').replace(/\.ya?ml$/, '') || 'my-dashboard'} onSave={writeTo} />
    <DashboardGuide projectId={projectId} open={guideOpen} onOpenChange={setGuideOpen} onUseTemplate={content => {
      if ((dirty || path) && !window.confirm('Replace the editor contents with this template? The saved file is kept; the template starts a new dashboard.')) return
      load(content, '', 'Template ready · Validate to show filters, then Preview. Check Run on and make sure the model is built.', false)
      setShowYaml(true)
    }} />
  </section>
}
