import { NextResponse } from 'next/server'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'

const STORAGE_DIR = process.env.STORAGE_DIR || '/data/storage'

function getSigningSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) {
    throw new Error('AUTH_SECRET is not configured')
  }
  return secret
}

// Resolve a path under `base` and guarantee it does not escape via traversal.
function resolveWithin(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments)
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep
  if (resolved !== base && !resolved.startsWith(baseWithSep)) {
    throw new Error('Invalid path')
  }
  return resolved
}

// Constant-time HMAC comparison.
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const filename = searchParams.get('filename')
  const token = searchParams.get('token')
  const exp = searchParams.get('exp')

  if (!filename || !token || !exp) {
    return NextResponse.json({ error: 'Missing params' }, { status: 400 })
  }

  let secret: string
  try {
    secret = getSigningSecret()
  } catch {
    // Fail closed: never accept a default/weak secret.
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  // Verify HMAC token: token = `${userId}.${HMAC(`${filename}:${exp}:${userId}`)}`
  const parts = token.split('.')
  if (parts.length !== 2) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 403 })
  }

  const [userId, hmac] = parts
  const data = `${filename}:${exp}:${userId}`
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex')
  if (!safeEqualHex(hmac, expected)) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 403 })
  }

  if (Date.now() > parseInt(exp) * 1000) {
    return NextResponse.json({ error: 'Token expired' }, { status: 403 })
  }

  // Even with a valid token, refuse paths that escape the user's directory.
  const userDir = path.join(path.resolve(STORAGE_DIR, 'files'), userId)
  let filePath: string
  try {
    filePath = resolveWithin(userDir, filename)
  } catch {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
  }

  try {
    const buffer = await fs.readFile(filePath)
    // RFC 5987 / 6266: sanitize the fallback filename and provide an encoded one
    // to avoid header injection via CR/LF/quotes in the filename.
    const baseName = path.basename(filename)
    const asciiName = baseName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\\r\n]/g, '_')
    const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(baseName)}`
    return new NextResponse(new Uint8Array(buffer), {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disposition },
    })
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }
}
