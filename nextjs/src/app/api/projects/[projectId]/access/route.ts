import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireProjectAccess } from '@/lib/authz'
import { ProjectPermissionLevel } from '@prisma/client'

/**
 * Who may view or edit one project - the ProjectPermission rows, not
 * users.role. See docs/rbac-design.md sections 1.2 and the backlog note on
 * letting an edit-level user manage access on their own project.
 */

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  const status =
    message === 'Not authenticated' ? 401 : message === 'Not found or not authorized' ? 404 : 400
  return NextResponse.json({ error: message }, { status })
}

const LEVELS = new Set<string>(Object.values(ProjectPermissionLevel))

export async function GET(
  _req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params
    await requireProjectAccess(projectId, 'view')

    // canManage tells the UI whether to show the grant/revoke controls at
    // all - the mutating endpoints below re-check this themselves regardless,
    // this is not the enforcement point.
    let canManage = true
    try {
      await requireProjectAccess(projectId, 'edit')
    } catch {
      canManage = false
    }

    const grants = await db.projectPermission.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, email: true, name: true, role: true } },
        granter: { select: { email: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      canManage,
      grants: grants.map((g) => ({
        userId: g.userId,
        email: g.user.email,
        name: g.user.name,
        role: g.user.role,
        level: g.level,
        grantedBy: g.granter.email,
        updatedAt: g.updatedAt,
      })),
    })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params
    const { userId: grantedBy } = await requireProjectAccess(projectId, 'edit')

    const body = await req.json().catch(() => null)
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const level = body?.level
    if (!email) return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    if (typeof level !== 'string' || !LEVELS.has(level)) {
      return NextResponse.json({ error: `level must be one of ${[...LEVELS].join(', ')}` }, { status: 400 })
    }

    const target = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (!target) {
      return NextResponse.json(
        { error: 'No account for that email yet - they need to sign in once first.' },
        { status: 404 },
      )
    }

    const grant = await db.projectPermission.upsert({
      where: { projectId_userId: { projectId, userId: target.id } },
      update: { level: level as ProjectPermissionLevel, grantedBy },
      create: {
        projectId,
        userId: target.id,
        level: level as ProjectPermissionLevel,
        grantedBy,
      },
      include: { user: { select: { email: true, name: true, role: true } } },
    })

    return NextResponse.json({
      userId: grant.userId,
      email: grant.user.email,
      name: grant.user.name,
      role: grant.user.role,
      level: grant.level,
    })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
