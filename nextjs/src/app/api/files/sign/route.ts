import { NextResponse } from 'next/server'
import { getSessionOrNull } from '@/lib/session'
import * as crypto from 'crypto'

// Mints an HMAC-signed, time-limited download URL for a file owned by the
// authenticated user. Token format MUST match /api/files/download/route.ts:
//   token = `${userId}.${HMAC_sha256(`${filename}:${exp}:${userId}`)}`
function getSigningSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) {
    throw new Error('AUTH_SECRET is not configured')
  }
  return secret
}

export async function POST(req: Request) {
  try {
    const session = await getSessionOrNull()
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { filename, ttlSeconds } = await req.json()
    if (!filename || typeof filename !== 'string') {
      return NextResponse.json({ error: 'filename required' }, { status: 400 })
    }

    const userId = session.user.id
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : 60
    const exp = Math.floor(Date.now() / 1000) + ttl
    const hmac = crypto
      .createHmac('sha256', getSigningSecret())
      .update(`${filename}:${exp}:${userId}`)
      .digest('hex')
    const token = `${userId}.${hmac}`
    const url = `/api/files/download?filename=${encodeURIComponent(filename)}&token=${token}&exp=${exp}`

    return NextResponse.json({ url })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
