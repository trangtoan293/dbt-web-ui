"use client"

import React from "react"
import { Database, FileText, Globe, Server } from "lucide-react"
import { SOURCE_KINDS, type SourceKind } from "@/lib/ingest-draft"

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  postgresql: Database,
  oracle: Database,
  mysql: Server,
  rest_api: Globe,
  filesystem: FileText,
}

interface Props {
  onPick: (kind: SourceKind) => void
  /** Connection types dbt-runner reports it can read, from /ingest/meta. */
  readableConnectionTypes: string[]
  fileRootsConfigured: boolean
}

/**
 * Where a load starts: every source this deployment can read, shown at once.
 *
 * A dropdown of three source types hid the interesting facts — that Oracle is
 * supported at all, that a public API needs no credential. A kind this server
 * cannot use is dimmed with the reason rather than hidden: hiding it means
 * nobody ever learns there is an operator to ask.
 */
export default function SourceGallery({
  onPick,
  readableConnectionTypes,
  fileRootsConfigured,
}: Props): React.ReactElement {
  function unavailableReason(kind: SourceKind): string | null {
    if (kind.sourceType === "filesystem") {
      return fileRootsConfigured
        ? null
        : "Switched off on this server — no ingest file roots are configured."
    }
    if (kind.sourceType === "rest_api") return null
    const readable = kind.connectionTypes.some((type) => readableConnectionTypes.includes(type))
    return readable ? null : "This server has no driver for it."
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SOURCE_KINDS.map((kind) => {
        const Icon = ICONS[kind.id] ?? Database
        const blocked = unavailableReason(kind)
        return (
          <button
            key={kind.id}
            type="button"
            disabled={Boolean(blocked)}
            onClick={() => onPick(kind)}
            className="group flex h-full flex-col items-start rounded-xl border border-slate-200 bg-white p-5 text-left transition-colors hover:border-[#0078D4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50"
          >
            <Icon className={`h-6 w-6 ${blocked ? "text-slate-300" : "text-[#0078D4]"}`} />
            <p className={`mt-3 font-medium ${blocked ? "text-slate-400" : "text-slate-900"}`}>
              {kind.label}
            </p>
            <p className="mt-1 text-sm text-slate-500">{kind.blurb}</p>
            {blocked && <p className="mt-2 text-xs text-amber-700">{blocked}</p>}
          </button>
        )
      })}
    </div>
  )
}
