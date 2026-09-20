"use client"

import React from "react"
import { Input } from "@/components-v2/ui/input"
import { qualifiedTableNames, type Draft, type SourceKind } from "@/lib/ingest-draft"

interface Props {
  kind: SourceKind
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
  projectName: string
}

/**
 * Name it, read back what it will do, and choose how it starts.
 *
 * The two buttons on the wizard's footer are deliberate. Saving and running are
 * different intentions — the first load is the one that reads the source in
 * full — and a single Save that quietly did neither was how a load could sit
 * configured and never once run.
 */
export default function FinishStep({ kind, draft, onChange, projectName }: Props): React.ReactElement {
  const untracked = draft.tables.filter((table) => !draft.tableConfig[table]?.cursorField)
  const isRest = kind.sourceType === "rest_api"

  return (
    <div className="space-y-5">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Load name</span>
        <Input
          value={draft.name}
          placeholder={`${kind.label} → ${draft.dataset || "raw"}`}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>

      {isRest && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Track new records using</span>
            <Input
              value={draft.cursorField}
              placeholder="attributes.updated_at"
              onChange={(event) => onChange({ cursorField: event.target.value })}
            />
            <span className="mt-1 block text-xs text-slate-500">
              A path into each record. One API sends one cursor for every resource, so this is
              set once here rather than per table.
            </span>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Start from</span>
            <Input
              value={draft.cursorInitialValue}
              placeholder="2026-01-01"
              disabled={!draft.cursorField.trim()}
              onChange={(event) => onChange({ cursorInitialValue: event.target.value })}
            />
            <span className="mt-1 block text-xs text-slate-500">
              Lower bound for the first run, so it need not read all history.
            </span>
          </label>
        </div>
      )}

      <fieldset className="rounded-lg border border-slate-200 bg-white p-4">
        <legend className="px-1 text-sm font-medium text-slate-700">
          When the source grows a column
        </legend>
        <div className="mt-1 space-y-2">
          {[
            {
              value: "evolve",
              label: "Add it to the destination",
              help: "The new column appears in the loaded table. Models that do not name it are unaffected.",
            },
            {
              value: "freeze",
              label: "Stop the load and tell me",
              help: "The run fails and names the column. Nothing is written, so nothing changes shape behind a model that was not expecting it.",
            },
          ].map((option) => (
            <label key={option.value} className="flex gap-3 text-sm">
              <input
                type="radio"
                name="schema-contract"
                className="mt-1"
                value={option.value}
                checked={draft.schemaContract === option.value}
                onChange={() => onChange({ schemaContract: option.value })}
              />
              <span>
                <span className="font-medium text-slate-800">{option.label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{option.help}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-lg border border-slate-200 bg-white">
        <p className="border-b border-slate-100 px-4 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          What this load does
        </p>
        <dl className="divide-y divide-slate-100 text-sm">
          {[
            ["Reads", `${kind.label} · ${draft.tables.length} table${draft.tables.length === 1 ? "" : "s"}`],
            ["Writes", `${qualifiedTableNames(draft)[0] ?? "—"}${draft.tables.length > 1 ? ` and ${draft.tables.length - 1} more` : ""}`],
            ["Project", projectName || "—"],
            [
              "Tracks changes",
              untracked.length === 0
                ? "Every table has a change-tracking column"
                : `${draft.tables.length - untracked.length} of ${draft.tables.length} tables`,
            ],
          ].map(([term, value]) => (
            <div key={term} className="flex gap-4 px-4 py-2.5">
              <dt className="w-32 shrink-0 text-slate-500">{term}</dt>
              <dd className="min-w-0 break-words text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {untracked.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">
            {untracked.length} table{untracked.length === 1 ? "" : "s"} will be read in full on
            every run
          </p>
          <p className="mt-1 font-mono text-xs">{untracked.join(", ")}</p>
          <p className="mt-2 text-xs">
            Fine for a reference table. At core-banking size it is the difference between a load
            that finishes and one that does not — go back and pick a column if there is one.
          </p>
        </div>
      )}
    </div>
  )
}
