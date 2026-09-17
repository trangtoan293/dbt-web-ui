import { auth } from '@/lib/auth'
import { db } from '@/lib/db'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getCurrentUserId(): Promise<string> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId || !UUID_PATTERN.test(userId)) {
    throw new Error('Not authenticated')
  }

  // JWTs can outlive a database restore/reset. Never let a stale session ID
  // reach an ownership FK; force the API caller down its normal 401 path.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!user) throw new Error('Not authenticated')
  return user.id
}

export async function getSessionOrNull() {
  const session = await auth()
  if (!session?.user?.id) return null
  return session
}
