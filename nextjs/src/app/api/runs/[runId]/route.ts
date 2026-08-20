import { NextResponse } from 'next/server'
import { getRunById } from '@/lib/actions/data'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params
    const run = await getRunById(runId)
    return NextResponse.json(run)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message === 'Not authenticated') return NextResponse.json({ error: message }, { status: 401 })
    if (message === 'Not found or not authorized') return NextResponse.json({ error: message }, { status: 404 })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
