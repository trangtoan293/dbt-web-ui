import { NextResponse } from 'next/server'
import { getProjects, createProject, getProjectById, updateProject, softDeleteProject, hardDeleteProject } from '@/lib/actions/data'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (id) {
      const project = await getProjectById(id)
      if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json(project)
    }
    const includeDeleted = searchParams.get('includeDeleted') === 'true'
    const projects = await getProjects(includeDeleted)
    return NextResponse.json(projects)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message === 'Not authenticated') return NextResponse.json({ error: message }, { status: 401 })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const project = await createProject(body)
    return NextResponse.json(project)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message === 'Not authenticated') return NextResponse.json({ error: message }, { status: 401 })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    const body = await req.json()
    const project = await updateProject(id, body)
    return NextResponse.json(project)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message === 'Not authenticated') return NextResponse.json({ error: message }, { status: 401 })
    if (message === 'Not found or not authorized') return NextResponse.json({ error: message }, { status: 404 })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    const hard = searchParams.get('hard') === 'true'
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    if (hard) {
      await hardDeleteProject(id)
    } else {
      await softDeleteProject(id)
    }
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message === 'Not authenticated') return NextResponse.json({ error: message }, { status: 401 })
    if (message === 'Not found or not authorized') return NextResponse.json({ error: message }, { status: 404 })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
