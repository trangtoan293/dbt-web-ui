import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/authz'
import { UserRole } from '@prisma/client'

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  const status = message === 'Not authenticated' ? 401 : message === 'Not authorized' ? 403 : 400
  return NextResponse.json({ error: message }, { status })
}

const ROLES = new Set<string>(Object.values(UserRole))

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const body = await req.json().catch(() => null)
    const role = body?.role
    if (typeof role !== 'string' || !ROLES.has(role)) {
      return NextResponse.json(
        { error: `role must be one of ${[...ROLES].join(', ')}` },
        { status: 400 },
      )
    }

    const target = await db.user.findUnique({ where: { id }, select: { role: true } })
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    // A UI-reachable way to demote the last admin would strand every non-admin
    // route behind requireAdmin() with no one left to grant it back - recovery
    // would need direct SQL. Refuse it here; the room for the actual demotion
    // is a second admin, or a deliberate SQL statement, not a stray click.
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = await db.user.count({ where: { role: 'admin' } })
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: 'Cannot demote the last admin. Promote someone else first.' },
          { status: 409 },
        )
      }
    }

    const updated = await db.user.update({
      where: { id },
      data: { role: role as UserRole },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    })
    return NextResponse.json({ user: updated })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
