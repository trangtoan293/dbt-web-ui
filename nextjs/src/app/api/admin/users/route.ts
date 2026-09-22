import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/authz'

/**
 * Every account that has ever signed in - role management, admin only.
 *
 * Listed, not "managed": creating or deleting the underlying account happens
 * in the identity provider (Keycloak), never here. A user shows up the first
 * time they sign in (JIT-provisioned in auth.ts's ensureOidcUser), so an
 * account created in Keycloak but never used will not appear yet.
 */

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  const status = message === 'Not authenticated' ? 401 : message === 'Not authorized' ? 403 : 400
  return NextResponse.json({ error: message }, { status })
}

export async function GET() {
  try {
    await requireAdmin()
    const users = await db.user.findMany({
      select: { id: true, email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ users })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
