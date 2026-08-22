import { NextResponse } from 'next/server'
import {
  createSchedule,
  deleteSchedule,
  getSchedules,
  updateSchedule,
  type ScheduleInput,
} from '@/lib/actions/data'

function errorResponse(err: unknown) {
  const msg = err instanceof Error ? err.message : 'Unknown error'
  if (msg === 'Not authenticated') return NextResponse.json({ error: msg }, { status: 401 })
  if (msg === 'Not found or not authorized') return NextResponse.json({ error: msg }, { status: 404 })
  // Everything else here is a validation message written for the user.
  return NextResponse.json({ error: msg }, { status: 400 })
}

export async function GET(req: Request) {
  try {
    const projectId = new URL(req.url).searchParams.get('projectId') ?? undefined
    return NextResponse.json(await getSchedules(projectId))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function POST(req: Request) {
  try {
    return NextResponse.json(await createSchedule((await req.json()) as ScheduleInput))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as ScheduleInput & { id?: string }
    if (!body?.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    return NextResponse.json(await updateSchedule(body.id, body))
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function DELETE(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await deleteSchedule(id)
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
