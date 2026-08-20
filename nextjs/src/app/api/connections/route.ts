import { NextResponse } from 'next/server'
import { getConnections, createConnection, deleteConnection, getDremioSources, deleteDremioSource, updateConnection, updateDremioSource } from '@/lib/actions/data'

const CONNECTION_TYPES = new Set(['postgresql', 'duckdb', 'dremio', 'oracle', 'spark'])

function omitSecrets<T extends Record<string, unknown>>(row: T) {
  const safe = { ...row }
  delete safe.passwordEncrypted
  delete safe.tokenEncrypted
  return safe
}

export async function GET() {
  try {
    const [connections, dremioSources] = await Promise.all([getConnections(), getDremioSources()])
    // Return BOTH. Dremio sources are tagged so consumers can distinguish them.
    const merged = [
      ...dremioSources.map((d) => ({ ...omitSecrets(d), connectionType: 'dremio' as const, _sourceTable: 'dremio_source' as const })),
      ...connections.map((c) => ({ ...omitSecrets(c), _sourceTable: 'connection' as const })),
    ]
    return NextResponse.json(merged)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    if (!CONNECTION_TYPES.has(body?.connectionType)) {
      return NextResponse.json(
        {
          error: `Unsupported connectionType: ${body?.connectionType ?? '(missing)'}. ` +
            `Supported: ${[...CONNECTION_TYPES].join(', ')}.`,
        },
        { status: 400 },
      )
    }
    const conn = await createConnection(body)
    return NextResponse.json({ ...omitSecrets(conn), _sourceTable: 'connection' as const })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    const type = searchParams.get('type')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const NOT_OWNED = 'Not found or not authorized'
    if (type === 'dremio') {
      await deleteDremioSource(id)
    } else if (type === 'connection') {
      await deleteConnection(id)
    } else {
      // No type hint: try connection, then dremio — but never swallow a real error.
      try {
        await deleteConnection(id)
      } catch (e: unknown) {
        if (e instanceof Error && e.message === NOT_OWNED) {
          await deleteDremioSource(id) // if this also throws NOT_OWNED, handled below
        } else {
          throw e
        }
      }
    }
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
    if (msg === 'Not found or not authorized') return NextResponse.json({ error: msg }, { status: 404 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    const type = searchParams.get('type')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const body = await req.json()
    if (type === 'dremio') {
      const updated = await updateDremioSource(id, {
        name: body.name,
        host: body.host,
        port: Number(body.port),
        username: body.username,
        tokenEncrypted: body.tokenEncrypted || undefined,
        catalog: body.database,
      })
      return NextResponse.json({ ...omitSecrets(updated), _sourceTable: 'dremio_source' as const, connectionType: 'dremio' as const })
    }
    const updated = await updateConnection(id, {
      connectionType: CONNECTION_TYPES.has(body.connectionType) ? body.connectionType : undefined,
      name: body.name,
      host: body.host,
      port: Number(body.port),
      database: body.database,
      username: body.username,
      passwordEncrypted: body.passwordEncrypted || undefined,
      sslMode: body.sslMode,
      extraConfig: body.extraConfig,
    })
    return NextResponse.json({ ...omitSecrets(updated), _sourceTable: 'connection' as const })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
    if (msg === 'Not found or not authorized') return NextResponse.json({ error: msg }, { status: 404 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
