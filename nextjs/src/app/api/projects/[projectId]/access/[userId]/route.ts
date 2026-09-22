import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireProjectAccess } from '@/lib/authz'

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  const status =
    message === 'Not authenticated' ? 401 : message === 'Not found or not authorized' ? 404 : 400
  return NextResponse.json({ error: message }, { status })
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ projectId: string; userId: string }> },
) {
  try {
    const { projectId, userId } = await context.params
    await requireProjectAccess(projectId, 'edit')

    await db.projectPermission.deleteMany({ where: { projectId, userId } })
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    return errorResponse(err)
  }
}
