"use client"
import { useEffect, useState } from "react"
import { apiClient } from "@/lib/api/client"

interface Environment { default: string | null; targets: { name: string; type?: string; database?: string; schema?: string }[]; notice?: string }
export default function ExecutionEnvironment({ projectId, value, onChange, disabled = false }: { projectId: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true
    apiClient.get<Environment>(`/charts/${projectId}/environment`).then(result => { if (alive) setEnvironment(result) }).catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [projectId])
  const active = environment?.targets.find(target => target.name === (value || environment.default))
  return <div className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500" title="Connection used to execute SQL. Project metadata is an artifact snapshot and may differ from this environment.">
    <span>Run on</span>
    {environment && environment.targets.length > 1 ? <select disabled={disabled} aria-label="Execution environment" value={value || environment.default || ''} onChange={event => onChange(event.target.value)} className="h-8 max-w-32 rounded border border-slate-200 px-2">{environment.targets.map(target => <option key={target.name} value={target.name}>{target.name}</option>)}</select>
      : <span className="font-medium text-slate-700">{active?.name || (error ? 'Profile default (unverified)' : environment ? 'Profile default (not resolved)' : 'Loading…')}</span>}
    {active && <span className="max-w-48 truncate" title={[active.type, active.database, active.schema].filter(Boolean).join(' · ')}>{[active.type, active.database, active.schema].filter(Boolean).join(' · ')}</span>}
  </div>
}
