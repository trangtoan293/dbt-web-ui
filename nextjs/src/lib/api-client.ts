import { getSession } from 'next-auth/react'

export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const session = await getSession()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (session?.accessToken) {
    headers['Authorization'] = `Bearer ${session.accessToken}`
  }

  const res = await fetch(url, { ...options, headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

// The UI was written against Supabase's snake_case column names, but Prisma
// returns camelCase. Map project rows back to snake_case so pages keep working.
/* eslint-disable @typescript-eslint/no-explicit-any */
function toSnakeProject(p: any): any {
  if (!p || typeof p !== 'object') return p
  return {
    ...p,
    git_url: p.gitUrl ?? null,
    git_branch: p.gitBranch ?? null,
    git_project_subdirectory: p.gitProjectSubdirectory ?? null,
    staging_dir: p.stagingDir ?? null,
    marts_dir: p.martsDir ?? null,
    sync_status: p.syncStatus ?? null,
    dremio_source_id: p.dremioSourceId ?? null,
    connection_id: p.connectionId ?? null,
    deleted_at: p.deletedAt ?? null,
    created_at: p.createdAt ?? null,
    updated_at: p.updatedAt ?? null,
    created_by: p.createdBy ?? null,
  }
}

export async function getProjects(includeDeleted = false) {
  const rows = await apiFetch<any[]>(`/api/projects?includeDeleted=${includeDeleted}`)
  return (rows || []).map(toSnakeProject)
}

export async function getProjectById(id: string) {
  const row = await apiFetch<any>(`/api/projects?id=${id}`)
  return toSnakeProject(row)
}

export async function createProject(data: Record<string, unknown>) {
  return apiFetch<any>('/api/projects', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateProject(id: string, data: Record<string, unknown>) {
  return apiFetch<any>(`/api/projects?id=${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function softDeleteProject(id: string) {
  return apiFetch<any>(`/api/projects?id=${id}&hard=false`, { method: 'DELETE' })
}

export async function hardDeleteProject(id: string) {
  return apiFetch<any>(`/api/projects?id=${id}&hard=true`, { method: 'DELETE' })
}

// --- Connections / Dremio sources ---

export async function getConnections() {
  return apiFetch<any[]>('/api/connections')
}

export async function createConnection(data: Record<string, unknown>) {
  return apiFetch<any>('/api/connections', { method: 'POST', body: JSON.stringify(data) })
}

export async function deleteConnection(id: string, type?: 'dremio' | 'connection') {
  const qs = type ? `?id=${id}&type=${type}` : `?id=${id}`
  return apiFetch<any>(`/api/connections${qs}`, { method: 'DELETE' })
}

export async function updateConnection(
  id: string,
  type: 'dremio' | 'connection',
  data: Record<string, unknown>
) {
  return apiFetch<any>(`/api/connections?id=${id}&type=${type}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function testConnectionById(id: string, type: 'dremio' | 'connection') {
  return apiFetch<{ success: boolean; message: string }>(
    `/api/connections/${id}/test?type=${type}`,
    { method: 'POST' }
  )
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// --- Ingest sources -------------------------------------------------------
// CRUD goes to the Next.js route (Prisma owns writes, as with connections);
// running a load goes to dbt-runner through the /api/dbt-runner proxy.

export interface IngestSourceRow {
  id: string
  projectId: string
  sourceConnectionId: string
  name: string
  dataset: string
  tables: string[]
  destination: 'connection' | 'ducklake'
  writeDisposition: string
  primaryKey?: string[] | null
  partitionBy?: string[] | null
  sourceConnection?: { id: string; name: string; connectionType: string } | null
}

export async function getIngestSources(projectId?: string) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return apiFetch<IngestSourceRow[]>(`/api/ingest${query}`)
}

export async function createIngestSource(data: Record<string, unknown>) {
  return apiFetch('/api/ingest', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateIngestSource(id: string, data: Record<string, unknown>) {
  return apiFetch('/api/ingest', { method: 'PATCH', body: JSON.stringify({ id, ...data }) })
}

// --- Iceberg publish ------------------------------------------------------
// The lake lives in dbt-runner, so publishing goes through the proxy rather than
// Prisma: nothing about it is application state.

export interface IcebergPublishResult {
  success: boolean
  schema: string
  namespace?: string
  warehouse?: string
  /** One entry per table: "full: N file(s)", "incremental: +N file(s)", "unchanged". */
  published: Record<string, string>
}

export async function getIcebergMeta() {
  return apiFetch<{ configured: boolean; lakehouse_configured: boolean }>(
    '/api/dbt-runner/lake/iceberg/meta',
  )
}

export async function publishIceberg(projectId: string, schema: string, tables?: string[]) {
  return apiFetch<IcebergPublishResult>(`/api/dbt-runner/lake/iceberg/${projectId}`, {
    method: 'POST',
    body: JSON.stringify({ schema, ...(tables?.length ? { tables } : {}) }),
  })
}

export async function deleteIngestSource(id: string) {
  return apiFetch(`/api/ingest?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface ConnectionUsage {
  in_use: boolean
  blocked: boolean
  project_count: number
  projects: Array<{ id: string; name: string }>
  ingest_source_count: number
  ingest_sources: Array<{ id: string; name: string; dataset: string; project_name: string }>
}

/** What still depends on a connection, asked before offering to delete it. */
export async function getConnectionUsage(connectionId: string) {
  return apiFetch<ConnectionUsage>(`/api/dbt-runner/connection/usage/${connectionId}`)
}

export async function getIngestMeta() {
  return apiFetch<{
    source_connection_types: string[]
    destinations: string[]
    write_dispositions: string[]
    lakehouse_configured: boolean
  }>('/api/dbt-runner/ingest/meta')
}

export interface SystemInfo {
  version: string
  auth: { mode: "oidc" | "disabled"; issuer_configured: boolean }
  runs: {
    max_concurrent: number
    per_project_concurrent: number
    subprocess_timeout_seconds: number
    history_retention_days: number
  }
  scheduler: {
    enabled: boolean
    running: boolean
    leader: boolean
    tick_seconds: number
    misfire_grace_seconds: number
  }
  worker: { warm_pool_enabled: boolean; warm_pool_size: number }
  lakehouse: {
    configured: boolean
    snapshot_retention_days: number
    maintenance_interval_hours: number
    inline_row_limit: number
  }
  ingest: { allow_private_hosts: boolean; subprocess_timeout_seconds: number }
  adapters: string[]
}

/** Deployment settings that otherwise only exist as environment variables. */
export async function getSystemInfo() {
  return apiFetch<SystemInfo>('/api/dbt-runner/system/info')
}

export async function getIngestConnectionTables(connectionId: string) {
  return apiFetch<{ success: boolean; tables: string[]; message?: string }>(
    `/api/dbt-runner/ingest/connections/${connectionId}/tables`,
  )
}

export async function getIngestDbtSources(sourceId: string) {
  return apiFetch<{ success: boolean; dataset: string; content: string }>(
    `/api/dbt-runner/ingest/sources/${sourceId}/dbt-sources`,
  )
}

export async function cancelIngest(sourceId: string) {
  return apiFetch(`/api/dbt-runner/ingest/sources/${sourceId}/cancel`, { method: 'POST' })
}

export interface IngestRunRow {
  id: string
  status: string
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  rows_loaded: number | null
  tables: Record<string, unknown> | null
  error_message: string | null
}

export async function getIngestRuns(sourceId: string, limit = 25) {
  return apiFetch<{ items: IngestRunRow[] }>(
    `/api/dbt-runner/ingest/sources/${sourceId}/runs?limit=${limit}`,
  )
}

export async function getIngestRunLogs(runId: string) {
  return apiFetch<{ id: string; status: string; logs: string }>(
    `/api/dbt-runner/ingest/runs/${runId}/logs`,
  )
}

// --- Schedules ------------------------------------------------------------
// CRUD is Prisma-side (same pattern as ingest sources); the runner only reads
// the rows and fires them.

export type RunCommandName =
  | 'run'
  | 'test'
  | 'build'
  | 'compile'
  | 'docs'
  | 'deps'
  | 'clean'
  | 'seed'
  | 'snapshot'
  | 'source_freshness'

export interface ScheduleRow {
  id: string
  projectId: string
  name: string
  command: RunCommandName
  selector: string | null
  target: string | null
  cron: string
  isActive: boolean
  webhookUrl: string | null
  publishSchema: string | null
  lastRunAt: string | null
  lastRunId: string | null
  lastStatus: string | null
  nextRunAt: string | null
  project?: { id: string; name: string } | null
}

export async function getSchedules(projectId?: string) {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return apiFetch<ScheduleRow[]>(`/api/schedules${query}`)
}

export async function createSchedule(data: Record<string, unknown>) {
  return apiFetch<ScheduleRow>('/api/schedules', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateSchedule(id: string, data: Record<string, unknown>) {
  return apiFetch<ScheduleRow>('/api/schedules', {
    method: 'PATCH',
    body: JSON.stringify({ id, ...data }),
  })
}

export async function deleteSchedule(id: string) {
  return apiFetch(`/api/schedules?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// --- Project targets ------------------------------------------------------

export interface ProjectTargetRow {
  id: string
  projectId: string
  name: string
  connectionId: string
  connection?: { id: string; name: string; connectionType: string } | null
}

export async function getProjectTargets(projectId: string) {
  return apiFetch<ProjectTargetRow[]>(`/api/targets?projectId=${encodeURIComponent(projectId)}`)
}

export async function createProjectTarget(data: Record<string, unknown>) {
  return apiFetch<ProjectTargetRow>('/api/targets', { method: 'POST', body: JSON.stringify(data) })
}

export async function deleteProjectTarget(id: string) {
  return apiFetch(`/api/targets?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}
