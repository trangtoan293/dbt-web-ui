"use client"

import Link from "next/link"
import React, { useCallback, useEffect, useState } from "react"
import { Check, Loader2, X } from "lucide-react"
import { testConnectionById } from "@/lib/api-client"
import FileSourceFields, { type FileSourceConfig } from "@/components-v2/sources/FileSourceFields"
import type { Draft, SourceKind } from "@/lib/ingest-draft"

interface Props {
  kind: SourceKind
  draft: Draft
  onChange: (patch: Partial<Draft>) => void
  connections: Array<{ id: string; name: string; connectionType: string }>
  fileRoots: string[]
}

type TestState = { status: "idle" | "testing" | "ok" | "failed"; message?: string }

/**
 * Pick the connection, and find out straight away whether it works.
 *
 * The test runs on selection rather than on a button: `/connection/test` has
 * existed the whole time and nothing in the load form called it, so a wrong
 * password first surfaced in the log tail of the first run — after the entire
 * wizard had been filled in.
 */
export default function ConnectionStep({
  kind,
  draft,
  onChange,
  connections,
  fileRoots,
}: Props): React.ReactElement {
  const [test, setTest] = useState<TestState>({ status: "idle" })

  const runTest = useCallback(async (connectionId: string) => {
    if (!connectionId) return setTest({ status: "idle" })
    setTest({ status: "testing" })
    try {
      const result = await testConnectionById(connectionId, "connection")
      setTest(
        result.success
          ? { status: "ok", message: result.message }
          : { status: "failed", message: result.message },
      )
    } catch (error) {
      setTest({
        status: "failed",
        message: error instanceof Error ? error.message : "The test could not be run",
      })
    }
  }, [])

  useEffect(() => {
    runTest(draft.connectionId)
  }, [draft.connectionId, runTest])

  const needsConnection = kind.requiresConnection
  const label = needsConnection ? `${kind.label} connection` : "Credential (optional)"

  return (
    <div className="space-y-5">
      {kind.sourceType === "filesystem" ? (
        <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
          File loads read a directory on the server. There is no connection to choose.
        </p>
      ) : (
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">{label}</span>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={draft.connectionId}
            onChange={(event) => onChange({ connectionId: event.target.value, tables: [], tableConfig: {} })}
          >
            <option value="">
              {needsConnection ? "Select…" : "None — the API is public"}
            </option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
          {connections.length === 0 && (
            <span className="mt-1 block text-xs text-amber-700">
              No {kind.label} connection saved yet.{" "}
              <Link href="/data?tab=connections" className="underline">
                Add one
              </Link>
              {kind.requiresConnection ? "" : ", or leave this empty and enter the base URL below"}.
            </span>
          )}
        </label>
      )}

      {draft.connectionId && (
        <div
          role="status"
          className={`rounded-lg border px-4 py-3 text-sm ${
            test.status === "failed"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-slate-200 bg-slate-50 text-slate-700"
          }`}
        >
          <div className="flex items-center gap-2">
            {test.status === "testing" && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
            {test.status === "ok" && <Check className="h-4 w-4 text-emerald-600" />}
            {test.status === "failed" && <X className="h-4 w-4 text-red-600" />}
            <span className="font-medium">
              {test.status === "testing" && "Checking the connection…"}
              {test.status === "ok" && "Connected. Credentials accepted."}
              {test.status === "failed" && "Could not connect"}
            </span>
          </div>
          {test.status === "failed" && (
            <div className="mt-2 space-y-2">
              <p className="break-words font-mono text-xs">{test.message}</p>
              <p className="text-xs">
                Check the host, port and password on{" "}
                <Link href="/data?tab=connections" className="underline">
                  the connection
                </Link>
                , then come back — this retests automatically.
              </p>
            </div>
          )}
        </div>
      )}

      {kind.sourceType === "filesystem" && (
        <FileSourceFields
          config={draft.sourceConfig as FileSourceConfig}
          onChange={(next) => onChange({ sourceConfig: next as Record<string, unknown> })}
          roots={fileRoots}
        />
      )}

      {kind.sourceType === "rest_api" && (
        <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
          The API&apos;s base URL, its endpoints and the test that fetches one come next, with
          the resources they belong to. A public API needs no credential here.
        </p>
      )}
    </div>
  )
}
