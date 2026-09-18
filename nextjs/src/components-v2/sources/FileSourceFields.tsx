"use client"

import React from "react"
import { Input } from "@/components-v2/ui/input"

export interface FileSourceConfig {
  bucket_url?: string
  file_glob?: string
  format?: string
}

interface Props {
  config: FileSourceConfig
  onChange: (next: FileSourceConfig) => void
  /** The server directories a source may read, from /ingest/meta. */
  roots: string[]
}

const FORMATS = ["csv", "jsonl", "parquet"] as const

const SELECT_CLS = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm"

/**
 * Whether a typed directory sits under one of the allowed roots.
 *
 * The same check the server does, minus symlink resolution - it exists to say
 * "this path is outside" while someone is typing, not to decide anything.
 * dbt-runner refuses for real in file_source.validate_bucket_url.
 */
function underARoot(path: string, roots: string[]): boolean {
  const target = path.trim().replace(/^file:\/\//, "").replace(/\/+$/, "")
  if (!target) return true
  return roots.some((root) => {
    const base = root.replace(/\/+$/, "")
    return target === base || target.startsWith(`${base}/`)
  })
}

export default function FileSourceFields({
  config,
  onChange,
  roots,
}: Props): React.ReactElement {
  const set = (field: keyof FileSourceConfig) => (value: string) =>
    onChange({ ...config, [field]: value })

  return (
    <div className="space-y-4 rounded-md border border-gray-200 p-3">
      {!roots.length && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No ingest file roots are configured on the server, so a filesystem source
          cannot run yet. Set <code>INGEST_FILE_ROOTS</code> to the directories a
          source may read from — dbt-runner can read anywhere its user can, which is
          why the paths are fenced rather than free.
        </p>
      )}

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Directory</span>
        <Input
          value={config.bucket_url ?? ""}
          onChange={(e) => set("bucket_url")(e.target.value)}
          placeholder={roots[0] ? `${roots[0].replace(/\/+$/, "")}/crm` : "/data/drop/crm"}
        />
        {/* Naming the roots here rather than only in the refusal: "must be inside
            a configured root" is unusable advice when the roots are invisible. */}
        {roots.length > 0 && (
          <span className="mt-1 block text-xs text-gray-500">
            Must be inside {roots.length > 1 ? "one of" : ""}{" "}
            {roots.map((root) => (
              <code key={root} className="mr-1 rounded bg-gray-100 px-1">{root}</code>
            ))}
          </span>
        )}
        {!underARoot(config.bucket_url ?? "", roots) && (
          <span className="mt-1 block text-xs text-amber-700">
            This path is outside those directories — the load will be refused.
          </span>
        )}
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">File pattern</span>
          <Input
            value={config.file_glob ?? ""}
            onChange={(e) => set("file_glob")(e.target.value)}
            placeholder="*.csv"
          />
          <span className="mt-1 block text-xs text-gray-500">
            Relative to the directory. Defaults to every file.
          </span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Format</span>
          <select
            className={SELECT_CLS}
            value={config.format ?? "csv"}
            onChange={(e) => set("format")(e.target.value)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-gray-500">
        One directory loads into one table, so this source needs exactly one table
        name above — every matching file is appended to it.
      </p>
    </div>
  )
}
