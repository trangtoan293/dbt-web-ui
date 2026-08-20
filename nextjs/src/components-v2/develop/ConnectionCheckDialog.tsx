"use client"

import React, { useState } from "react"
import { CheckCircle, XCircle, AlertCircle, Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components-v2/ui/dialog"
import { apiClient } from "@/lib/api/client"

interface CheckResult {
  all_conditions_met: boolean
  condition_1_has_connection: boolean
  condition_2_profile_names_match: boolean
  condition_3_session_passed: boolean
  connection_type: string | null
  connection_id: string | null
  dremio_source_id: string | null
  profile_name_in_dbt_project_yml: string | null
  profile_name_in_profiles_yml: string | null
  profiles_yml_preview: string | null
  profiles_yml_on_disk: string | null
  errors: string[]
}

interface Props {
  projectId: string
}

export default function ConnectionCheckDialog({ projectId }: Props) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const [fetchError, setFetchError] = useState("")

  async function runCheck() {
    setLoading(true)
    setFetchError("")
    setResult(null)
    try {
      const data = await apiClient.get<CheckResult>(`/dbt/check-connection/${projectId}`)
      setResult(data)
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Request failed")
    } finally {
      setLoading(false)
    }
  }

  function handleOpen() {
    setOpen(true)
    runCheck()
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleOpen} title="Check connection diagnostic">
        <ShieldCheck className="h-4 w-4" />
        Check Connection
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Connection Diagnostic</DialogTitle>
          </DialogHeader>

          {loading && (
            <div className="flex items-center gap-2 py-8 justify-center text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin" /> Running checks...
            </div>
          )}

          {fetchError && (
            <div className="flex items-center gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              <XCircle className="h-4 w-4 shrink-0" /> {fetchError}
            </div>
          )}

          {result && (
            <div className="space-y-4">
              {/* Overall status */}
              <div className={`flex items-center gap-3 rounded-lg p-4 border ${result.all_conditions_met ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
                {result.all_conditions_met
                  ? <CheckCircle className="h-6 w-6 text-green-600 shrink-0" />
                  : <AlertCircle className="h-6 w-6 text-amber-600 shrink-0" />}
                <div>
                  <p className={`font-semibold ${result.all_conditions_met ? "text-green-800" : "text-amber-800"}`}>
                    {result.all_conditions_met ? "All conditions met — profiles.yml will regenerate" : "Some conditions not met — check below"}
                  </p>
                  {result.connection_type && (
                    <p className="text-sm text-gray-600 mt-0.5">Connection type: <span className="font-mono font-medium">{result.connection_type}</span></p>
                  )}
                </div>
              </div>

              {/* 3 conditions */}
              <div className="space-y-2">
                <Condition
                  ok={result.condition_1_has_connection}
                  label="Project linked to connection"
                  detail={
                    result.condition_1_has_connection
                      ? `connection_id: ${result.connection_id ?? result.dremio_source_id}`
                      : "connection_id and dremio_source_id are both NULL — link a connection to this project"
                  }
                />
                <Condition
                  ok={result.condition_2_profile_names_match}
                  label="Profile name matches dbt_project.yml"
                  detail={
                    result.profile_name_in_dbt_project_yml
                      ? `dbt_project.yml: "${result.profile_name_in_dbt_project_yml}" · profiles.yml: "${result.profile_name_in_profiles_yml ?? "(not generated yet)"}"`
                      : "dbt_project.yml not found — project not yet initialized"
                  }
                />
                <Condition
                  ok={result.condition_3_session_passed}
                  label="Session passed (HTTP path)"
                  detail="Always true for HTTP API calls. The streaming terminal also regenerates."
                />
              </div>

              {/* Errors */}
              {result.errors.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-1">
                  <p className="text-sm font-medium text-red-700">Errors</p>
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-600 font-mono">{e}</p>
                  ))}
                </div>
              )}

              {/* profiles.yml preview */}
              {result.profiles_yml_preview && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Generated profiles.yml (from DB)</p>
                  <pre className="rounded-md bg-gray-900 text-green-400 text-xs p-3 overflow-x-auto whitespace-pre font-mono">
                    {result.profiles_yml_preview}
                  </pre>
                </div>
              )}

              {/* On-disk comparison */}
              {result.profiles_yml_on_disk && result.profiles_yml_preview && result.profiles_yml_on_disk.trim() !== result.profiles_yml_preview.trim() && (
                <div>
                  <p className="text-sm font-medium text-amber-700 mb-1">⚠ Current profiles.yml on disk differs from DB version</p>
                  <pre className="rounded-md bg-gray-800 text-amber-300 text-xs p-3 overflow-x-auto whitespace-pre font-mono">
                    {result.profiles_yml_on_disk}
                  </pre>
                </div>
              )}

              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={runCheck} disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Re-check
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Condition({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className={`flex gap-3 rounded-md border p-3 ${ok ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
      {ok
        ? <CheckCircle className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
        : <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />}
      <div>
        <p className={`text-sm font-medium ${ok ? "text-green-800" : "text-red-700"}`}>{label}</p>
        <p className="text-xs text-gray-600 mt-0.5">{detail}</p>
      </div>
    </div>
  )
}
