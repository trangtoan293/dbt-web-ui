import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { getSessionOrNull } from '@/lib/session'

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const TYPES = new Set(['text', 'password'])

interface EnvVarInput {
  name?: unknown
  value?: unknown
  type?: unknown
  keepExisting?: unknown
}

function serializeEnvVar(row: {
  id: string
  name: string
  type: string
  valueEncrypted: string
  updatedAt: Date
}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'password' ? 'password' : 'text',
    hasValue: Boolean(row.valueEncrypted),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function requireOwnedProject(projectId: string, userId: string) {
  const project = await db.dbtProject.findFirst({
    where: { id: projectId, createdBy: userId, deletedAt: null },
    select: { id: true },
  })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  return null
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const session = await getSessionOrNull()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { projectId } = await context.params
  const ownershipError = await requireOwnedProject(projectId, session.user.id)
  if (ownershipError) return ownershipError

  const rows = await db.dbtEnvironmentVariable.findMany({
    where: { projectId, owner: session.user.id },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(rows.map(serializeEnvVar))
}

export async function PUT(
  req: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const session = await getSessionOrNull()
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { projectId } = await context.params
  const ownershipError = await requireOwnedProject(projectId, session.user.id)
  if (ownershipError) return ownershipError

  const body = await req.json().catch(() => null)
  if (!Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an array of environment variables' }, { status: 400 })
  }

  const existingRows = await db.dbtEnvironmentVariable.findMany({
    where: { projectId, owner: session.user.id },
  })
  const existingByName = new Map(existingRows.map((row) => [row.name, row]))
  const seen = new Set<string>()
  const replacements: Array<{ name: string; type: 'text' | 'password'; valueEncrypted: string }> = []

  for (const item of body as EnvVarInput[]) {
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!name) continue
    if (!ENV_NAME_RE.test(name)) {
      return NextResponse.json({ error: `Invalid environment variable name: ${name}` }, { status: 400 })
    }
    if (seen.has(name)) {
      return NextResponse.json({ error: `Duplicate environment variable name: ${name}` }, { status: 400 })
    }
    seen.add(name)

    const type = item.type === 'password' ? 'password' : 'text'
    if (typeof item.type === 'string' && !TYPES.has(item.type)) {
      return NextResponse.json({ error: `Invalid environment variable type for ${name}` }, { status: 400 })
    }

    const value = typeof item.value === 'string' ? item.value : undefined
    const existing = existingByName.get(name)
    let valueEncrypted = ''
    if (value && value.length > 0) {
      valueEncrypted = encryptSecret(value)
    } else if (item.keepExisting === true && existing) {
      valueEncrypted = existing.valueEncrypted
    } else {
      return NextResponse.json({ error: `Missing value for environment variable: ${name}` }, { status: 400 })
    }

    replacements.push({ name, type, valueEncrypted })
  }

  const rows = await db.$transaction(async (tx) => {
    await tx.dbtEnvironmentVariable.deleteMany({
      where: { projectId, owner: session.user.id },
    })
    if (replacements.length === 0) return []
    await tx.dbtEnvironmentVariable.createMany({
      data: replacements.map((item) => ({
        projectId,
        owner: session.user.id,
        name: item.name,
        type: item.type,
        valueEncrypted: item.valueEncrypted,
      })),
    })
    return tx.dbtEnvironmentVariable.findMany({
      where: { projectId, owner: session.user.id },
      orderBy: { name: 'asc' },
    })
  })

  return NextResponse.json(rows.map(serializeEnvVar))
}
