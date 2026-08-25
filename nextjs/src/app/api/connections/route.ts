import { NextResponse } from 'next/server'
import { getConnections, createConnection, deleteConnection, getDremioSources, deleteDremioSource, updateConnection, updateDremioSource, getConnectionById } from '@/lib/actions/data'
import { auth } from '@/lib/auth'
import { checkLakehouse, releaseLakehouse, LAKEHOUSE_TYPE, type LakehouseMode } from '@/lib/lakehouse'

const CONNECTION_TYPES = new Set(['postgresql', 'duckdb', 'dremio', 'oracle', 'spark', LAKEHOUSE_TYPE])

async function accessToken(): Promise<string | undefined> {
  const session = await auth()
  return (session as { accessToken?: string } | null)?.accessToken
}

/**
 * What to store in `extra_config` for a lakehouse, decided by dbt-runner.
 *
 * Never composed here: a managed lake's location comes from this deployment's
 * settings and an external one's is user input that has to clear the host guard,
 * the data-path allowlist and the identifier check. `probe: false` because a
 * save should not fail on a warehouse that happens to be down - the Test button
 * is where connectivity is reported.
 */
async function lakehouseExtraConfig(
  body: Record<string, unknown>,
  connectionId: string,
): Promise<{ ok: true; extraConfig: Record<string, unknown> } | { ok: false; error: string }> {
  const extra = (body.extraConfig ?? {}) as Record<string, unknown>
  const result = await checkLakehouse(
    {
      mode: (extra.mode as LakehouseMode) ?? 'managed',
      catalogType: extra.catalog_type as 'postgresql' | 'sqlite' | undefined,
      host: String(body.host ?? ''),
      port: body.port == null ? null : Number(body.port),
      database: String(body.database ?? ''),
      username: String(body.username ?? ''),
      password: String(body.passwordEncrypted ?? ''),
      dataPath: extra.data_path as string | undefined,
      metadataSchema: extra.metadata_schema as string | undefined,
      maintained: extra.maintained as boolean | undefined,
      connectionId,
      probe: false,
    },
    await accessToken(),
  )
  if (!result.success) return { ok: false, error: result.message ?? 'Invalid lakehouse' }
  return { ok: true, extraConfig: result.extraConfig ?? {} }
}

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
    if (body.connectionType === LAKEHOUSE_TYPE) {
      const id = crypto.randomUUID()
      const checked = await lakehouseExtraConfig(body, id)
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 })
      const lake = await createConnection({ ...body, id, extraConfig: checked.extraConfig })
      return NextResponse.json({ ...omitSecrets(lake), _sourceTable: 'connection' as const })
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

    // A lakehouse is released before its row goes: dbt-runner refuses while a
    // project still points at it, and deletes a managed lake's catalog schema
    // and Parquet, which nothing else would ever clean up.
    const existing = type === 'dremio' ? null : await getConnectionById(id).catch(() => null)
    if ((existing as { connectionType?: string } | null)?.connectionType === LAKEHOUSE_TYPE) {
      const released = await releaseLakehouse(id, await accessToken())
      if (!released.ok) {
        return NextResponse.json({ error: released.message }, { status: 409 })
      }
    }

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
    let extraConfig = body.extraConfig
    if (body.connectionType === LAKEHOUSE_TYPE) {
      const checked = await lakehouseExtraConfig(body, id)
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 })
      extraConfig = checked.extraConfig
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
      extraConfig,
    })
    return NextResponse.json({ ...omitSecrets(updated), _sourceTable: 'connection' as const })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
    if (msg === 'Not found or not authorized') return NextResponse.json({ error: msg }, { status: 404 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
