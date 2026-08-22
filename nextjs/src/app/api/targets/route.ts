import { NextResponse } from 'next/server'
import {
  createProjectTarget,
  deleteProjectTarget,
  getProjectTargets,
  updateProjectTarget,
  type ProjectTargetInput,
} from '@/lib/actions/data'

function errorResponse(err: unknown) {
  const msg = err instanceof Error ? err.message : 'Unknown error'
  if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
  if (msg === 'Not found or not authorized') return NextResponse.json({ error: msg }, { status: 404 })
  return NextResponse.json({ error: msg }, { status: 400 })
}

export async function GET(req: Request) {
  try {
    const projectId = new URL(req.url).searchParams.get('projectId')
    if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    return NextResponse.json(await getProjectTargets(projectId))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function POST(req: Request) {
  try {
    return NextResponse.json(await createProjectTarget((await req.json()) as ProjectTargetInput))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as ProjectTargetInput & { id?: string }
    if (!body?.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    return NextResponse.json(await updateProjectTarget(body.id, body))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await deleteProjectTarget(id)
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
