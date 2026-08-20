import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getDbtRunnerUrl } from '@/lib/api/client'
import { getConnectionById, getDremioSourceById } from '@/lib/actions/data'
import { decryptSecret } from '@/lib/crypto'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') ?? 'connection'

  const row =
    type === 'dremio' ? await getDremioSourceById(id) : await getConnectionById(id)
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let payload: { type: string; name: string; config: Record<string, unknown> }
  if (type === 'dremio') {
    const d = row as {
      name: string
      host: string
      port: number
      tokenEncrypted: string
      username: string
    }
    payload = {
      type: 'dremio',
      name: d.name,
      config: {
        host: d.host,
        port: d.port,
        user: d.username,
        pat: decryptSecret(d.tokenEncrypted),
      },
    }
  } else {
    const c = row as {
      name: string
      connectionType: string
      host: string
      port: number
      database: string
      username: string
      passwordEncrypted: string | null
      sslMode: string | null
      extraConfig: unknown
    }
    if (c.connectionType === 'dremio') {
      const extraConfig = ((c.extraConfig as Record<string, unknown> | null) ?? {})
      const authType = extraConfig.auth_type === 'password' ? 'password' : 'pat'
      const credential = decryptSecret(c.passwordEncrypted)
      const authConfig =
        authType === 'password' ? { password: credential } : { pat: credential }
      payload = {
        type: 'dremio',
        name: c.name,
        config: {
          host: c.host,
          port: c.port,
          user: c.username,
          dremio_space: c.database || `@${c.username}`,
          ...authConfig,
          ...extraConfig,
        },
      }
    } else if (c.connectionType === 'duckdb') {
      payload = {
        type: 'duckdb',
        name: c.name,
        config: { path: c.database },
      }
    } else if (c.connectionType === 'oracle') {
      const extraConfig = ((c.extraConfig as Record<string, unknown> | null) ?? {})
      const schema = (extraConfig.schema as string) || c.username.toUpperCase()
      payload = {
        type: 'oracle',
        name: c.name,
        config: {
          host: c.host,
          port: c.port,
          user: c.username,
          password: decryptSecret(c.passwordEncrypted),
          service: c.database,
          schema,
        },
      }
    } else if (c.connectionType === 'spark') {
      const extraConfig = ((c.extraConfig as Record<string, unknown> | null) ?? {})
      const secretType = extraConfig.secret_type === 'password' || extraConfig.secret_type === 'token'
        ? extraConfig.secret_type
        : 'none'
      const credential = secretType === 'none' ? '' : decryptSecret(c.passwordEncrypted)
      payload = {
        type: 'spark',
        name: c.name,
        config: {
          host: c.host,
          port: c.port,
          schema: c.database,
          user: c.username,
          ...extraConfig,
          ...(secretType === 'password' ? { password: credential } : {}),
          ...(secretType === 'token' ? { token: credential } : {}),
        },
      }
    } else {
      const baseConfig: Record<string, unknown> = {
        host: c.host,
        port: c.port,
        user: c.username,
        password: decryptSecret(c.passwordEncrypted),
        dbname: c.database,
        schema: 'public',
      }
      payload = { type: 'postgresql', name: c.name, config: baseConfig }
    }
  }

  const accessToken = (session as { accessToken?: string }).accessToken
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

  const res = await fetch(`${getDbtRunnerUrl()}/connection/test`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  const data = await res.json().catch(() => ({ success: false, message: 'Invalid response' }))
  return NextResponse.json(data, { status: res.ok ? 200 : 502 })
}
