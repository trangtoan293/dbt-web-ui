import { NextResponse } from 'next/server'
import { getRuns, getAllRunsAcrossProjects } from '@/lib/actions/data'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId')

    if (projectId) {
      const runs = await getRuns(projectId)
      return NextResponse.json(runs)
    }

    const runs = await getAllRunsAcrossProjects()
    return NextResponse.json(runs)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message === 'Not authenticated') return NextResponse.json({ error: message }, { status: 401 })
    if (message === 'Not found or not authorized') return NextResponse.json({ error: message }, { status: 404 })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
