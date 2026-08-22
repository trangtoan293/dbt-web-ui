import { NextResponse } from 'next/server'
import {
  createIngestSource,
  deleteIngestSource,
  getIngestSources,
  updateIngestSource,
  type IngestSourceInput,
} from '@/lib/actions/data'

function errorResponse(err: unknown) {
  const msg = err instanceof Error ? err.message : 'Unknown error'
  if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
  if (msg === 'Not found or not authorized') return NextResponse.json({ error: msg }, { status: 404 })
  // Validation messages from validateIngestSource are meant for the user.
  return NextResponse.json({ error: msg }, { status: 400 })
}

export async function GET(req: Request) {
  try {
    const projectId = new URL(req.url).searchParams.get('projectId') ?? undefined
    return NextResponse.json(await getIngestSources(projectId))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as IngestSourceInput
    return NextResponse.json(await createIngestSource(body))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as IngestSourceInput & { id?: string }
    if (!body?.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    return NextResponse.json(await updateIngestSource(body.id, body))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await deleteIngestSource(id)
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
