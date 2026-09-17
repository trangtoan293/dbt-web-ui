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
  /** From /ingest/meta: false means no INGEST_FILE_ROOTS is set server-side. */
  rootsConfigured: boolean
}

const FORMATS = ["csv", "jsonl", "parquet"] as const

const SELECT_CLS = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm"

export default function FileSourceFields({
  config,
  onChange,
  rootsConfigured,
}: Props): React.ReactElement {
  const set = (field: keyof FileSourceConfig) => (value: string) =>
    onChange({ ...config, [field]: value })

  return (
    <div className="space-y-4 rounded-md border border-gray-200 p-3">
      {!rootsConfigured && (
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
          placeholder="/data/drop/crm"
        />
        <span className="mt-1 block text-xs text-gray-500">
          Must be inside one of the server&apos;s configured ingest roots.
        </span>
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
