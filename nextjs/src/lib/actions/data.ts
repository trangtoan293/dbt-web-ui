'use server'

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { getCurrentUserId } from '@/lib/session'
import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'

// --- Projects ---

export async function getProjects(includeDeleted = false) {
  const userId = await getCurrentUserId()
  return db.dbtProject.findMany({
    where: { createdBy: userId, deletedAt: includeDeleted ? undefined : null },
    orderBy: { createdAt: 'desc' },
    include: {
      dremioSource: true,
      connection: true,
      _count: { select: { runs: true } },
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          command: true,
          selector: true,
          modelsTotal: true,
          modelsSuccess: true,
          modelsError: true,
          createdAt: true,
          completedAt: true,
        },
      },
    },
  })
}

export async function getProjectById(id: string) {
  const userId = await getCurrentUserId()
  return db.dbtProject.findFirst({
    where: { id, createdBy: userId },
    include: { dremioSource: true, connection: true },
  })
}

export async function createProject(data: {
  name: string
  description?: string
  dremioSourceId?: string
  connectionId?: string
  gitUrl?: string
  gitBranch?: string
}) {
  const userId = await getCurrentUserId()
  const project = await db.dbtProject.create({
    data: { ...data, createdBy: userId },
  })
  revalidatePath('/develop')
  return project
}

export async function updateProject(id: string, data: {
  name?: string
  description?: string
  gitUrl?: string
  gitBranch?: string
  gitProjectSubdirectory?: string
  stagingDir?: string
  martsDir?: string
  syncStatus?: string
  dremioSourceId?: string | null
  connectionId?: string | null
}) {
  const userId = await getCurrentUserId()
  await ensureOwnership('dbtProject', id, userId)
  const project = await db.dbtProject.update({ where: { id }, data })
  revalidatePath('/develop')
  return project
}

export async function softDeleteProject(id: string) {
  const userId = await getCurrentUserId()
  await ensureOwnership('dbtProject', id, userId)
  await db.dbtProject.update({ where: { id }, data: { deletedAt: new Date() } })
  revalidatePath('/develop')
}

export async function restoreProject(id: string) {
  const userId = await getCurrentUserId()
  await ensureOwnership('dbtProject', id, userId)
  await db.dbtProject.update({ where: { id }, data: { deletedAt: null } })
  revalidatePath('/develop')
}

export async function hardDeleteProject(id: string) {
  const userId = await getCurrentUserId()
  await ensureOwnership('dbtProject', id, userId)
  await db.dbtProject.delete({ where: { id } })
  revalidatePath('/develop')
}

// --- Dremio Sources ---

export async function getDremioSources() {
  const userId = await getCurrentUserId()
  return db.dremioSource.findMany({
    where: { createdBy: userId },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createDremioSource(data: {
  name: string
  host: string
  port: number
  username: string
  tokenEncrypted: string
  catalog?: string
  arrowFlightPort?: number
}) {
  const userId = await getCurrentUserId()
  const tokenEncrypted = encryptSecret(data.tokenEncrypted)
  return db.dremioSource.create({
    data: { ...data, tokenEncrypted, createdBy: userId },
  })
}

export async function deleteDremioSource(id: string) {
  const userId = await getCurrentUserId()
  await ensureOwnership('dremioSource', id, userId)
  await db.dremioSource.delete({ where: { id } })
  revalidatePath('/connections')
}

// --- Connections ---

export async function getConnections() {
  const userId = await getCurrentUserId()
  return db.connection.findMany({
    where: { createdBy: userId, isActive: true },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createConnection(data: {
  name: string
  connectionType: 'postgresql' | 'duckdb' | 'dremio' | 'oracle' | 'spark'
  host: string
  port: number
  database: string
  username: string
  passwordEncrypted?: string
  sslMode?: string
  extraConfig?: Prisma.InputJsonValue
}) {
  const userId = await getCurrentUserId()
  const createData = {
    ...data,
    passwordEncrypted: data.passwordEncrypted
      ? encryptSecret(data.passwordEncrypted)
      : undefined,
    createdBy: userId,
  }
  return db.connection.create({
    data: createData,
  })
}

export async function deleteConnection(id: string) {
  const userId = await getCurrentUserId()
  await ensureOwnership('connection', id, userId)
  await db.connection.delete({ where: { id } })
  revalidatePath('/connections')
}

export async function getConnectionById(id: string) {
  const userId = await getCurrentUserId()
  return db.connection.findFirst({ where: { id, createdBy: userId } })
}

export async function getDremioSourceById(id: string) {
  const userId = await getCurrentUserId()
  return db.dremioSource.findFirst({ where: { id, createdBy: userId } })
}

export async function updateConnection(
  id: string,
  data: {
    connectionType?: 'postgresql' | 'duckdb' | 'dremio' | 'oracle' | 'spark'
    name: string
    host: string
    port: number
    database: string
    username: string
    passwordEncrypted?: string | null
    sslMode?: string | null
    extraConfig?: Prisma.InputJsonValue
  }
) {
  const userId = await getCurrentUserId()
  await ensureOwnership('connection', id, userId)
  const update: Record<string, unknown> = {
    name: data.name,
    connectionType: data.connectionType,
    host: data.host,
    port: data.port,
    database: data.database,
    username: data.username,
    sslMode: data.sslMode ?? null,
    extraConfig: data.extraConfig ?? undefined,
  }
  if (!data.connectionType) delete update.connectionType
  if (data.passwordEncrypted) update.passwordEncrypted = encryptSecret(data.passwordEncrypted)
  return db.connection.update({ where: { id }, data: update })
}

export async function updateDremioSource(
  id: string,
  data: {
    name: string
    host: string
    port: number
    username: string
    tokenEncrypted?: string | null
    catalog?: string
    arrowFlightPort?: number
  }
) {
  const userId = await getCurrentUserId()
  await ensureOwnership('dremioSource', id, userId)
  const update: Record<string, unknown> = {
    name: data.name,
    host: data.host,
    port: data.port,
    username: data.username,
    catalog: data.catalog ?? '',
    arrowFlightPort: data.arrowFlightPort ?? 32010,
  }
  if (data.tokenEncrypted) update.tokenEncrypted = encryptSecret(data.tokenEncrypted)
  return db.dremioSource.update({ where: { id }, data: update })
}

// --- Runs ---

/* eslint-disable @typescript-eslint/no-explicit-any */
function serializeRun(run: any) {
  return {
    ...run,
    durationMs: run.durationMs == null ? null : Number(run.durationMs),
    project: run.project
      ? {
          id: run.project.id,
          name: run.project.name,
        }
      : undefined,
    artifacts: run.artifacts?.map((artifact: any) => ({
      ...artifact,
    })),
  }
}

export async function getRuns(projectId: string) {
  const userId = await getCurrentUserId()
  const project = await db.dbtProject.findFirst({
    where: { id: projectId, createdBy: userId, deletedAt: null },
    select: { id: true },
  })
  if (!project) throw new Error('Not found or not authorized')

  const runs = await db.dbtRun.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      _count: { select: { artifacts: true } },
    },
  })
  return runs.map(serializeRun)
}

export async function getAllRunsAcrossProjects() {
  const userId = await getCurrentUserId()
  const projects = await db.dbtProject.findMany({
    where: { createdBy: userId, deletedAt: null },
    select: { id: true },
  })
  const projectIds = projects.map((p) => p.id)
  if (projectIds.length === 0) return []

  const runs = await db.dbtRun.findMany({
    where: { projectId: { in: projectIds } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      project: { select: { id: true, name: true } },
      _count: { select: { artifacts: true } },
    },
  })
  return runs.map(serializeRun)
}

export async function getRunById(runId: string) {
  const userId = await getCurrentUserId()
  const run = await db.dbtRun.findUnique({
    where: { id: runId },
    include: {
      project: { select: { id: true, name: true, createdBy: true } },
      artifacts: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!run || run.project.createdBy !== userId) {
    throw new Error('Not found or not authorized')
  }
  return serializeRun(run)
}

// --- Helpers ---

async function ensureOwnership(model: string, id: string, userId: string) {
  const record = await (db as any)[model].findUnique({ where: { id } })
  if (!record || record.createdBy !== userId) {
    throw new Error('Not found or not authorized')
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
