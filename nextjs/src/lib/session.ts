import { auth } from '@/lib/auth'

export async function getCurrentUserId(): Promise<string> {
  const session = await auth()
  if (!session?.user?.id) {
    throw new Error('Not authenticated')
  }
  return session.user.id
}

export async function getSessionOrNull() {
  const session = await auth()
  if (!session?.user?.id) return null
  return session
}
