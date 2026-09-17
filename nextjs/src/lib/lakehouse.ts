/**
 * Server-side calls into dbt-runner for lakehouse connections.
 *
 * A lakehouse row is saved by Prisma like any other connection, but nothing
 * about it may be composed here: the catalog URL, the data path and the
 * metadata schema are checked against this deployment's own settings and the
 * host guard, both of which live in dbt-runner. So the frontend asks dbt-runner
 * what to store and stores exactly that.
 */
import { getDbtRunnerUrl } from '@/lib/api/client'

export const LAKEHOUSE_TYPE = 'ducklake'

export type LakehouseMode = 'managed' | 'external'

export interface LakehouseCheckPayload {
  mode: LakehouseMode
  catalogType?: 'postgresql' | 'sqlite'
  host?: string
  port?: number | null
  database?: string
  username?: string
  password?: string
  dataPath?: string
  metadataSchema?: string
  maintained?: boolean
  connectionId?: string
  probe?: boolean
}

export interface LakehouseCheckResult {
  success: boolean
  message?: string
  extraConfig?: Record<string, unknown>
  details?: Record<string, unknown>
}

function headers(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (accessToken) h['Authorization'] = `Bearer ${accessToken}`
  return h
}

export async function checkLakehouse(
  payload: LakehouseCheckPayload,
  accessToken?: string,
): Promise<LakehouseCheckResult> {
  const res = await fetch(`${getDbtRunnerUrl()}/lakehouse/check`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => null)) as LakehouseCheckResult | null
  if (!data) return { success: false, message: 'Could not reach dbt-runner' }
  return data
}

/**
 * Let dbt-runner release a lakehouse before its row is deleted.
 *
 * Returns the error message when it refuses, so the caller can pass it on: the
 * usual refusal is "still attached to a project", which the person deleting
 * needs to read rather than a generic failure.
 */
export async function releaseLakehouse(
  connectionId: string,
  accessToken?: string,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`${getDbtRunnerUrl()}/lakehouse/${connectionId}`, {
    method: 'DELETE',
    headers: headers(accessToken),
  })
  if (res.ok) return { ok: true }
  const data = (await res.json().catch(() => null)) as { detail?: string } | null
  return { ok: false, message: data?.detail || `dbt-runner returned ${res.status}` }
}
