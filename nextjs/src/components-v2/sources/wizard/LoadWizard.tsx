"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import React, { useCallback, useEffect, useState } from "react"
import { ArrowLeft, Loader2 } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import SourceGallery from "./SourceGallery"
import ConnectionStep from "./ConnectionStep"
import TableStep from "./TableStep"
import DestinationStep from "./DestinationStep"
import FinishStep from "./FinishStep"
import {
  createIngestSource,
  getConnections,
  getIngestMeta,
  getIngestSources,
  getProjects,
  updateIngestSource,
} from "@/lib/api-client"
import {
  SOURCE_KINDS,
  WIZARD_STEPS,
  draftToInput,
  emptyDraft,
  stepProblem,
  type Draft,
  type SourceKind,
  type WizardStep,
} from "@/lib/ingest-draft"

type Project = { id: string; name: string; lakehouseConnectionId?: string | null }
type Connection = { id: string; name: string; connectionType: string; _sourceTable?: string }

interface Props {
  /** Editing an existing load rather than writing a new one. */
  sourceId?: string
}

/**
 * The whole load-setup flow, as a page rather than a dialog.
 *
 * A dialog was the constraint that shaped the old form: a table of per-table
 * settings and a panel of sample rows do not fit in `max-w-2xl`, so the form
 * asked for a table name and a cursor as free text and found out whether they
 * existed an hour later. Everything here follows from having the room to show
 * the source before committing to it.
 */
export default function LoadWizard({ sourceId }: Props): React.ReactElement {
  const router = useRouter()
  const [step, setStep] = useState<WizardStep>(0)
  const [kind, setKind] = useState<SourceKind | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [meta, setMeta] = useState({
    source_connection_types: [] as string[],
    lakehouse_configured: false,
    file_roots: [] as string[],
  })
  const [loading, setLoading] = useState(Boolean(sourceId))
  const [saving, setSaving] = useState<"save" | "run" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadProjects = useCallback(async () => {
    const rows = await getProjects()
    setProjects(Array.isArray(rows) ? rows : [])
  }, [])

  useEffect(() => {
    Promise.all([
      loadProjects(),
      getConnections().then((rows) => setConnections(Array.isArray(rows) ? rows : [])),
      getIngestMeta().then((m) =>
        setMeta({
          source_connection_types: m.source_connection_types ?? [],
          lakehouse_configured: Boolean(m.lakehouse_configured),
          file_roots: m.file_roots ?? [],
        }),
      ),
    ]).catch((caught) =>
      setError(caught instanceof Error ? caught.message : "Could not load the form"),
    )
  }, [loadProjects])

  // Editing: rebuild the draft from the stored row and skip the source gallery,
  // because a saved load cannot change what kind of thing it reads.
  useEffect(() => {
    if (!sourceId) return
    let cancelled = false
    getIngestSources()
      .then((rows) => {
        if (cancelled) return
        const existing = (Array.isArray(rows) ? rows : []).find((row) => row.id === sourceId)
        if (!existing) throw new Error("This load no longer exists")
        const matched =
          SOURCE_KINDS.find(
            (candidate) =>
              candidate.sourceType === existing.sourceType &&
              (!existing.sourceConnection ||
                candidate.connectionTypes.includes(existing.sourceConnection.connectionType)),
          ) ?? SOURCE_KINDS.find((candidate) => candidate.sourceType === existing.sourceType)!
        setKind(matched)
        setDraft({
          ...emptyDraft(matched, true),
          connectionId: existing.sourceConnectionId ?? "",
          tables: (existing.tables as string[]) ?? [],
          tableConfig: (existing.tableConfig as Draft["tableConfig"]) ?? {},
          sourceConfig: (existing.sourceConfig as Record<string, unknown>) ?? {},
          projectId: existing.projectId,
          destination: existing.destination,
          name: existing.name,
          dataset: existing.dataset,
          partitionBy: ((existing.partitionBy as string[]) ?? []).join(", "),
          cursorField: existing.cursorField ?? "",
          cursorInitialValue: existing.cursorInitialValue ?? "",
          writeDisposition: existing.writeDisposition,
          schemaContract: existing.schemaContract ?? "evolve",
          primaryKey: ((existing.primaryKey as string[]) ?? []).join(", "),
        })
        setStep(1)
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : "Could not open this load"),
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [sourceId])

  const patch = useCallback((changes: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current))
  }, [])

  const project = projects.find((candidate) => candidate.id === draft?.projectId)
  const context = {
    kind: kind!,
    fileRootsConfigured: meta.file_roots.length > 0,
    projectHasLake: Boolean(project?.lakehouseConnectionId),
  }

  const relevantConnections = connections.filter(
    (connection) =>
      connection._sourceTable === "connection" &&
      (kind?.connectionTypes ?? []).includes(connection.connectionType),
  )

  function goNext() {
    if (!draft || !kind) return
    const problem = stepProblem(draft, step as WizardStep, context)
    if (problem) return setError(problem)
    setError(null)
    setStep((current) => Math.min(4, current + 1) as WizardStep)
  }

  async function save(andRun: boolean) {
    if (!draft || !kind) return
    // Re-check every step, not only the last: someone can walk backwards and
    // break an earlier one, and the wizard would otherwise save it anyway.
    for (const candidate of [1, 2, 3, 4] as WizardStep[]) {
      const problem = stepProblem(draft, candidate, context)
      if (problem) {
        setStep(candidate)
        return setError(problem)
      }
    }
    setError(null)
    setSaving(andRun ? "run" : "save")
    try {
      const input = draftToInput(draft)
      const saved = sourceId
        ? await updateIngestSource(sourceId, input)
        : await createIngestSource(input)
      const id = (saved as { id?: string })?.id ?? sourceId
      router.push(`/data/loads/${id}${andRun ? "?run=1" : ""}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this load")
      setSaving(null)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <Link
          href="/data"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" /> Data loads
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          {sourceId ? "Edit data load" : "New data load"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {
            [
              "Choose what you are copying data from.",
              "Connect to it, and confirm the connection works.",
              "Pick the tables, and decide how each one stays up to date.",
              "Choose where the rows land and what they will be called.",
              "Name it and start the first load.",
            ][step]
          }
        </p>
      </div>

      <ol aria-label="Load setup steps" className="grid gap-2 sm:grid-cols-5">
        {WIZARD_STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={step === index ? "step" : undefined}
            className={`rounded-lg px-3 py-2 text-sm ${
              step === index
                ? "bg-blue-50 font-semibold text-[#0078D4]"
                : index < step
                  ? "text-slate-600"
                  : "text-slate-400"
            }`}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {step === 0 || !draft || !kind ? (
        <SourceGallery
          readableConnectionTypes={meta.source_connection_types}
          fileRootsConfigured={meta.file_roots.length > 0}
          onPick={(picked) => {
            setKind(picked)
            setDraft(emptyDraft(picked, meta.lakehouse_configured))
            setError(null)
            setStep(1)
          }}
        />
      ) : (
        <>
          {step === 1 && (
            <ConnectionStep
              kind={kind}
              draft={draft}
              onChange={patch}
              connections={relevantConnections}
              fileRoots={meta.file_roots}
            />
          )}
          {step === 2 && <TableStep kind={kind} draft={draft} onChange={patch} />}
          {step === 3 && (
            <DestinationStep
              draft={draft}
              onChange={patch}
              projects={projects}
              lakehouseConfigured={meta.lakehouse_configured}
              onProjectsChanged={loadProjects}
            />
          )}
          {step === 4 && (
            <FinishStep
              kind={kind}
              draft={draft}
              onChange={patch}
              projectName={project?.name ?? ""}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <Button
              variant="outline"
              disabled={Boolean(saving)}
              onClick={() => {
                setError(null)
                setStep((current) => Math.max(sourceId ? 1 : 0, current - 1) as WizardStep)
              }}
            >
              Back
            </Button>
            {step < 4 ? (
              <Button onClick={goNext}>Continue</Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="outline" disabled={Boolean(saving)} onClick={() => save(false)}>
                  {saving === "save" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save, don&apos;t run yet
                </Button>
                <Button disabled={Boolean(saving)} onClick={() => save(true)}>
                  {saving === "run" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save and run the first load
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
