import { NextResponse } from 'next/server'
import { getSessionOrNull } from '@/lib/session'
import * as fs from 'fs/promises'
import * as path from 'path'

const STORAGE_DIR = process.env.STORAGE_DIR || '/data/storage'

function getStorageRoot() {
  return path.resolve(STORAGE_DIR, 'files')
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

export async function GET() {
  try {
    const session = await getSessionOrNull()
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const userId = session.user.id
    const userDir = path.join(getStorageRoot(), userId)
    await fs.mkdir(userDir, { recursive: true }).catch(() => {})

    const files = await fs.readdir(userDir, { withFileTypes: true })
    const result = files
      .filter(f => f.isFile())
      .map(f => ({ name: f.name }))
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSessionOrNull()
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const userId = session.user.id
    const userDir = path.join(getStorageRoot(), userId)
    await fs.mkdir(userDir, { recursive: true })

    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

    const safeName = file.name.replace(/[^0-9a-zA-Z!\-_.*'()]/g, '_')
    const filePath = path.join(userDir, safeName)
    const buffer = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(filePath, buffer)

    return NextResponse.json({ name: safeName, success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getSessionOrNull()
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const userId = session.user.id
    const { searchParams } = new URL(req.url)
    const filename = searchParams.get('filename')
    if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 })

    const userDir = path.join(getStorageRoot(), userId)
    let filePath: string
    try {
      filePath = resolveWithin(userDir, filename)
    } catch {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
    }
    await fs.unlink(filePath).catch(() => {})
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
