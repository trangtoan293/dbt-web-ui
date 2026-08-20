import { NextResponse } from 'next/server'
import { RunCommand } from '@prisma/client'
import { getRuns, getAllRunsAcrossProjects, getRunLogDashboard } from '@/lib/actions/data'

const RUN_STATUSES = new Set(['pending', 'running', 'success', 'error', 'cancelled'])

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId')

    if (searchParams.get('view') === 'logs') {
      const status = searchParams.get('status') || undefined
      const commandValue = searchParams.get('command')
      const command = commandValue && Object.values(RunCommand).includes(commandValue as RunCommand)
        ? commandValue as RunCommand
        : undefined
      const dashboard = await getRunLogDashboard({
        projectId: projectId || undefined,
        status: status && RUN_STATUSES.has(status) ? status : undefined,
        command,
        search: searchParams.get('search') || undefined,
        from: parseDate(searchParams.get('from')),
        to: parseDate(searchParams.get('to')),
        page: parsePositiveInt(searchParams.get('page'), 1),
        pageSize: Math.min(100, parsePositiveInt(searchParams.get('pageSize'), 25)),
      })
      return NextResponse.json(dashboard)
    }

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
