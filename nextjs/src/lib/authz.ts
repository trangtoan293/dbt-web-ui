/**
 * RBAC checks for the Next.js side. See docs/rbac-design.md.
 *
 * Role is a ceiling: admin bypasses ProjectPermission entirely, contributor
 * and viewer can only act on a project that has a ProjectPermission row for
 * them. A viewer never edits, whatever a grant row says - role narrows a
 * grant, a grant can never widen a role.
 *
 * Nothing here trusts a role cached in the session JWT. Every check re-reads
 * `users.role` from Postgres, the same way dbt-runner's authorize_project
 * does independently on its side (app/core/auth.py) - two backends, two
 * enforcement points, neither trusting the other's token.
 */
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/session'
import type { Prisma } from '@prisma/client'

export type ProjectAction = 'view' | 'edit'

async function loadRole(userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (!user) throw new Error('Not authenticated')
  return user.role
}

/** Current user's id and role, freshly read from Postgres. */
export async function getCurrentUserRole(): Promise<{ userId: string; role: string }> {
  const userId = await getCurrentUserId()
  return { userId, role: await loadRole(userId) }
}

/**
 * Throws unless userId may perform `action` on projectId. Same 404-shaped
 * "Not found" message on every rejection as dbt-runner's authorize_project -
 * a more specific error would confirm the project exists to someone who has
 * no business knowing that.
 */
export async function requireProjectAccess(
  projectId: string,
  action: ProjectAction,
): Promise<{ userId: string; role: string }> {
  const userId = await getCurrentUserId()
  const role = await loadRole(userId)
  if (role === 'admin') return { userId, role }

  const grant = await db.projectPermission.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { level: true },
  })
  const allowed = Boolean(
    grant && (action === 'view' || (grant.level === 'edit' && role !== 'viewer')),
  )
  if (!allowed) throw new Error('Not found or not authorized')
  return { userId, role }
}

/** Throws unless the current user is admin. Returns their id for callers that
 * need it (audit fields, revalidation) without a second session lookup. */
export async function requireAdmin(): Promise<string> {
  const { userId, role } = await getCurrentUserRole()
  if (role !== 'admin') throw new Error('Not authorized')
  return userId
}

/**
 * Prisma `where` fragment restricting a DbtProject query to what userId may
 * view: everything for admin, only projects with a grant row for anyone
 * else. For a query already joined through DbtProject (runs, schedules,
 * ingest sources, targets), nest this under `project: { ... }`.
 */
export function visibleProjectsWhere(role: string, userId: string): Prisma.DbtProjectWhereInput {
  if (role === 'admin') return {}
  return { permissions: { some: { userId } } }
}
