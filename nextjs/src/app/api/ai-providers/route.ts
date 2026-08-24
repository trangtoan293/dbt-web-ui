import { NextResponse } from 'next/server'
import { getCurrentUserId } from '@/lib/session'
import {
  CATALOG_ROUTES,
  PROTOCOLS,
  deleteProvider,
  listProviders,
  upsertProvider,
} from '@/lib/ai-providers'

/**
 * The user's model providers for the dbt assistant.
 *
 * Reads never return a key, only whether one is stored for the route's
 * credential reference: a write-only field is what keeps a stolen session from
 * reading the secret back out.
 */

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  const status = message === 'Not authenticated' ? 401 : 400
  return NextResponse.json({ error: message }, { status })
}

export async function GET() {
  try {
    const providers = await listProviders(await getCurrentUserId())
    return NextResponse.json({
      providers,
      // The choices the harness's adapter accepts, so the form does not hardcode
      // a list that can drift from it.
      protocols: PROTOCOLS,
      catalogRoutes: CATALOG_ROUTES,
    })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const userId = await getCurrentUserId()
    const body = await request.json().catch(() => ({}))
    if (typeof body?.route !== 'string') {
      return NextResponse.json({ error: 'route is required' }, { status: 400 })
    }
    return NextResponse.json({ providers: await upsertProvider(userId, body) })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const userId = await getCurrentUserId()
    const route = new URL(request.url).searchParams.get('route')
    if (!route) return NextResponse.json({ error: 'route is required' }, { status: 400 })
    return NextResponse.json({ providers: await deleteProvider(userId, route) })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
