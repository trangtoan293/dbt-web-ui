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
