"use client"

import { useEffect, useState } from 'react'
import { Button } from '@/components-v2/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components-v2/ui/dialog'
import Markdown from '@/components-v2/develop/agent/Markdown'
import { dbtApi } from '@/lib/api'
import { apiClient } from '@/lib/api/client'
import { metadataEntries, type DataEntry } from '@/lib/explore-data'
import { BOARD_TEMPLATES, type TemplateField } from '@/lib/dashboard-guide'
import { cn } from '@/lib/utils'

interface Reference {
  renderer: string
  examples: { slug: string; title: string; notes: string; yaml: string }[]
  topics: { slug: string; title: string; body: string }[]
}

type Section = 'model' | 'samples' | 'reference'
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'model', label: 'Start from a model' },
  { id: 'samples', label: 'Board samples' },
  { id: 'reference', label: 'YAML reference' },
]
const FIELD_LABELS: Record<TemplateField, string> = {
  dimension: 'Group by column', measure: 'Numeric measure column', date: 'Date column',
}
const CONTROL = 'mt-1 h-9 w-full rounded border border-slate-200 bg-white px-2 text-xs'

export default function DashboardGuide({ projectId, open, onOpenChange, onUseTemplate }: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseTemplate: (yaml: string) => void
}) {
  const [section, setSection] = useState<Section>('model')
  const [entries, setEntries] = useState<DataEntry[]>([])
  const [selected, setSelected] = useState('')
  const [template, setTemplate] = useState(BOARD_TEMPLATES[0].id)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [reference, setReference] = useState<Reference | null>(null)
  const [topic, setTopic] = useState('cheatsheet')
  const [expanded, setExpanded] = useState('')
  const entry = entries.find(item => item.id === selected)
  const shape = BOARD_TEMPLATES.find(item => item.id === template) ?? BOARD_TEMPLATES[0]
  const ready = entry && shape.fields.every(field => entry.columns.some(column => column.name === picks[field]))

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true); setError(''); setEntries([]); setSelected(''); setPicks({})
    dbtApi.getIntellisense(projectId).then(result => { if (alive) setEntries(metadataEntries(result)) })
      .catch(issue => { if (alive) setError(issue.message || 'Unable to load project metadata') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, projectId, retry])

  useEffect(() => {
    // The samples and the reference ship with the pinned engine; fetch them once.
    if (!open || reference || section === 'model') return
    let alive = true
    apiClient.get<Reference>('/charts/reference').then(result => { if (alive) setReference(result) })
      .catch(issue => { if (alive) setError((issue as Error).message) })
    return () => { alive = false }
  }, [open, section, reference])

  function use(yaml: string) { onUseTemplate(yaml); onOpenChange(false) }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
    <DialogHeader>
      <DialogTitle>Samples and guide</DialogTitle>
      <DialogDescription>Generate a dashboard from one of your models, copy a ready-made board, or read the YAML reference.</DialogDescription>
    </DialogHeader>
    <nav aria-label="Guide sections" className="flex gap-1 border-b border-slate-200 pb-2">
      {SECTIONS.map(item => <button key={item.id} type="button" aria-pressed={section === item.id} onClick={() => setSection(item.id)}
        className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium', section === item.id ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100')}>{item.label}</button>)}
    </nav>

    {section === 'model' && <section className="space-y-3">
      <p className="text-xs text-slate-600">Every template writes real SQL against the selected model with <code>{'{{ ref() }}'}</code>, declares its filters, and formats its numbers. Validate, then Preview.</p>
      {loading ? <p role="status" className="text-xs">Loading project models…</p>
        : error ? <p role="alert" className="text-xs text-red-700">{error} <button className="underline" onClick={() => setRetry(value => value + 1)}>Retry</button></p>
        : !entries.length ? <p className="text-xs">No metadata yet. Generate dbt Docs for this project, then reopen this guide. You can still write the YAML by hand — see Board samples.</p>
        : <>
          <label className="block text-xs">Model or source<select aria-label="Dashboard model" className={CONTROL} value={selected} onChange={event => { setSelected(event.target.value); setPicks({}) }}>
            <option value="">Select a model or source</option>{entries.map(item => <option key={item.id} value={item.id}>{item.kind} · {item.name} · {item.path}</option>)}</select></label>
          {entry && <>
            <code className="block overflow-x-auto text-[11px] text-slate-500">{entry.expression}</code>
            <fieldset className="space-y-2"><legend className="text-xs font-semibold">Template</legend>
              {BOARD_TEMPLATES.map(item => <label key={item.id} className="flex gap-2 rounded border border-slate-200 p-2 text-xs">
                <input type="radio" name="board-template" className="mt-0.5" checked={template === item.id} onChange={() => setTemplate(item.id)} />
                <span><strong className="block">{item.title}</strong><span className="text-slate-600">{item.description}</span></span></label>)}
            </fieldset>
            <div className="grid gap-2 sm:grid-cols-3">{shape.fields.map(field => <label key={field} className="text-xs">{FIELD_LABELS[field]}
              <select aria-label={FIELD_LABELS[field]} className={CONTROL} value={picks[field] ?? ''} onChange={event => setPicks(current => ({ ...current, [field]: event.target.value }))}>
                <option value="">Select column</option>{entry.columns.map(column => <option key={column.name} value={column.name}>{column.name} · {column.data_type || 'type unavailable'}</option>)}
              </select></label>)}</div>
            {!entry.columns.length && <p className="text-xs text-amber-700">This model has no recorded columns. Generate Docs and try again.</p>}
            <p className="text-[11px] text-slate-500">Metadata is a project snapshot, not the live schema of the Run on environment. A measure must be numeric — cast it in SQL if the column stores text. Date grouping uses <code>date_trunc</code>; adjust it for a warehouse that spells it differently.</p>
            <Button size="sm" disabled={!ready} onClick={() => { if (entry && ready) use(shape.build(entry, picks)) }}>Use this template</Button>
          </>}
        </>}
    </section>}

    {section === 'samples' && <section className="space-y-3">
      <p className="text-xs text-slate-600">Complete boards shipped with the renderer. They carry inline data, so they render without touching your warehouse — replace the <code>values</code> with SQL once you have the shape you want.</p>
      {!reference ? <p role="status" className="text-xs">Loading samples…</p> : reference.examples.map(example => <article key={example.slug} className="rounded border border-slate-200 p-3">
        <h3 className="text-sm font-semibold">{example.title}</h3>
        <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{example.notes}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => use(example.yaml)}>Use this board</Button>
          <Button size="sm" variant="ghost" aria-expanded={expanded === example.slug} onClick={() => setExpanded(expanded === example.slug ? '' : example.slug)}>{expanded === example.slug ? 'Hide' : 'Show'} YAML</Button>
          <span className="text-[11px] text-slate-400">{example.slug}</span>
        </div>
        {expanded === example.slug && <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-5">{example.yaml}</pre>}
      </article>)}
    </section>}

    {section === 'reference' && <section className="space-y-2">
      {!reference ? <p role="status" className="text-xs">Loading reference…</p> : <>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs">Topic<select aria-label="Reference topic" className={CONTROL} value={topic} onChange={event => setTopic(event.target.value)}>{reference.topics.map(item => <option key={item.slug} value={item.slug}>{item.title}</option>)}</select></label>
          <span className="self-end pb-1 text-[11px] text-slate-400">{reference.renderer}</span>
        </div>
        <p className="text-[11px] text-slate-500">Shipped with the installed engine, so it matches what the renderer accepts. Explore boards allow a subset: queries are SQL or inline values only, no external sources, files or custom themes.</p>
        <div className="max-h-[50dvh] overflow-auto rounded border border-slate-200 p-3 text-xs">
          <Markdown text={reference.topics.find(item => item.slug === topic)?.body ?? ''} />
        </div>
      </>}
    </section>}
  </DialogContent></Dialog>
}
