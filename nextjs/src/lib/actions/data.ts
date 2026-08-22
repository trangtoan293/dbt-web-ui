'use server'

import { db } from '@/lib/db'
import { encryptSecret } from '@/lib/crypto'
import { getCurrentUserId } from '@/lib/session'
import { isPlausibleCron } from '@/lib/cron'
import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import type { RunCommand } from '@prisma/client'

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
  revalidatePath('/data')
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
  revalidatePath('/data')
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

export type RunLogDashboardQuery = {
  projectId?: string
  status?: string
  command?: RunCommand
  search?: string
  from?: Date
  to?: Date
  page: number
  pageSize: number
}

export async function getRunLogDashboard(input: RunLogDashboardQuery) {
  const userId = await getCurrentUserId()
  const projects = await db.dbtProject.findMany({
    where: { createdBy: userId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
  const projectIds = projects.map((project) => project.id)
  const page = Math.max(1, input.page)
  const pageSize = Math.min(100, Math.max(10, input.pageSize))

  if (projectIds.length === 0) {
    return {
      items: [],
      pagination: { page, pageSize, total: 0, totalPages: 0 },
      summary: { total: 0, success: 0, error: 0, cancelled: 0, running: 0, pending: 0, averageDurationMs: null },
      facets: { projects },
    }
  }

  if (input.projectId && !projectIds.includes(input.projectId)) {
    throw new Error('Not found or not authorized')
  }

  const search = input.search?.trim()
  const matchingProjectIds = search
    ? projects
        .filter((project) => project.name.toLowerCase().includes(search.toLowerCase()))
        .map((project) => project.id)
    : []
  const dateFilter = input.from || input.to
    ? { gte: input.from, lte: input.to }
    : undefined
  const summaryWhere: Prisma.DbtRunWhereInput = {
    projectId: input.projectId || { in: projectIds },
    command: input.command,
    createdAt: dateFilter,
    ...(search
      ? {
          OR: [
            { selector: { contains: search, mode: 'insensitive' as const } },
            { errorMessage: { contains: search, mode: 'insensitive' as const } },
            { logs: { contains: search, mode: 'insensitive' as const } },
            ...(matchingProjectIds.length > 0 ? [{ projectId: { in: matchingProjectIds } }] : []),
            ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search) ? [{ id: search }] : []),
          ],
        }
      : {}),
  }
  const filteredWhere: Prisma.DbtRunWhereInput = {
    ...summaryWhere,
    status: input.status,
  }

  const [runs, total, statusGroups, durationAggregate] = await Promise.all([
    db.dbtRun.findMany({
      where: filteredWhere,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        projectId: true,
        command: true,
        selector: true,
        status: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
        modelsTotal: true,
        modelsSuccess: true,
        modelsError: true,
        errorMessage: true,
        gitCommit: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
        _count: { select: { artifacts: true } },
      },
    }),
    db.dbtRun.count({ where: filteredWhere }),
    db.dbtRun.groupBy({
      by: ['status'],
      where: summaryWhere,
      _count: { _all: true },
    }),
    db.dbtRun.aggregate({
      where: { ...summaryWhere, durationMs: { not: null } },
      _avg: { durationMs: true },
    }),
  ])

  const counts = Object.fromEntries(
    statusGroups.map((group) => [group.status, group._count._all]),
  )
  const summaryTotal = statusGroups.reduce((totalRuns, group) => totalRuns + group._count._all, 0)

  return {
    items: runs.map(serializeRun),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    },
    summary: {
      total: summaryTotal,
      success: counts.success || 0,
      error: counts.error || 0,
      cancelled: counts.cancelled || 0,
      running: counts.running || 0,
      pending: counts.pending || 0,
      averageDurationMs: durationAggregate._avg.durationMs == null
        ? null
        : Number(durationAggregate._avg.durationMs),
    },
    facets: { projects },
  }
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

// ---------------------------------------------------------------------------
// Ingest sources
//
// An ingest source stores no credentials: it references a Connection, which
// already owns the encrypted password. Nothing here needs encryptSecret.
// ---------------------------------------------------------------------------

const DATASET_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
const TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const WRITE_DISPOSITIONS = new Set(['append', 'replace', 'merge'])
// A partition term reaches DuckLake as DDL, not as a bound parameter: a bare
// column, or one date-part function over one. Kept in step with
// dbt-runner/ingest/lakehouse.py:_PARTITION_TERM_RE, which is the enforcing side.
const PARTITION_TERM_PATTERN =
  /^(?:(?:year|month|day|hour)\([A-Za-z_][A-Za-z0-9_$]{0,62}\)|[A-Za-z_][A-Za-z0-9_$]{0,62})$/i
const PARTITION_FUNCTIONS = ['year', 'month', 'day', 'hour']

export type IngestSourceInput = {
  projectId: string
  sourceConnectionId: string
  name: string
  dataset: string
  tables: string[]
  destination?: 'connection' | 'ducklake'
  writeDisposition?: string
  primaryKey?: string[]
  partitionBy?: string[]
}

/** Reject anything that would reach SQL as an identifier, before it is stored. */
function validateIngestSource(input: IngestSourceInput) {
  if (!input.name?.trim()) throw new Error('Name is required')
  if (!DATASET_PATTERN.test(input.dataset ?? '')) {
    throw new Error(
      'Dataset must start with a letter and use only lowercase letters, digits and underscores (max 40 characters)',
    )
  }
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    throw new Error('Select at least one table')
  }
  const badTables = input.tables.filter((t) => !TABLE_PATTERN.test(t))
  if (badTables.length) throw new Error(`Invalid table name(s): ${badTables.slice(0, 5).join(', ')}`)

  const disposition = input.writeDisposition ?? 'append'
  if (!WRITE_DISPOSITIONS.has(disposition)) {
    throw new Error(`writeDisposition must be one of ${[...WRITE_DISPOSITIONS].join(', ')}`)
  }
  if (disposition === 'merge' && !input.primaryKey?.length) {
    throw new Error('A primary key is required for merge')
  }

  for (const term of input.partitionBy ?? []) {
    if (!PARTITION_TERM_PATTERN.test(term)) {
      throw new Error(
        `Invalid partition term "${term}": use a column name, or ${PARTITION_FUNCTIONS.join('/')}(column)`,
      )
    }
  }
  if (input.partitionBy?.length && (input.destination ?? 'ducklake') !== 'ducklake') {
    throw new Error('Partitioning applies to the lakehouse destination only')
  }
}

export async function getIngestSources(projectId?: string) {
  const userId = await getCurrentUserId()
  return db.ingestSource.findMany({
    where: { createdBy: userId, ...(projectId ? { projectId } : {}) },
    include: { sourceConnection: { select: { id: true, name: true, connectionType: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createIngestSource(input: IngestSourceInput) {
  const userId = await getCurrentUserId()
  validateIngestSource(input)
  // Both the project and the connection must belong to the caller; without this
  // a user could ingest another user's warehouse into their own project.
  await ensureOwnership('dbtProject', input.projectId, userId)
  await ensureOwnership('connection', input.sourceConnectionId, userId)

  const created = await db.ingestSource.create({
    data: {
      projectId: input.projectId,
      sourceConnectionId: input.sourceConnectionId,
      name: input.name.trim(),
      dataset: input.dataset,
      tables: input.tables,
      destination: input.destination ?? 'ducklake',
      writeDisposition: input.writeDisposition ?? 'append',
      primaryKey: input.primaryKey?.length ? input.primaryKey : undefined,
      partitionBy: input.partitionBy?.length ? input.partitionBy : undefined,
      createdBy: userId,
    },
  })
  revalidatePath('/data')
  return created
}

export async function updateIngestSource(id: string, input: IngestSourceInput) {
  const userId = await getCurrentUserId()
  validateIngestSource(input)
  await ensureOwnership('ingestSource', id, userId)
  await ensureOwnership('connection', input.sourceConnectionId, userId)

  const updated = await db.ingestSource.update({
    where: { id },
    data: {
      sourceConnectionId: input.sourceConnectionId,
      name: input.name.trim(),
      dataset: input.dataset,
      tables: input.tables,
      destination: input.destination ?? 'ducklake',
      writeDisposition: input.writeDisposition ?? 'append',
      primaryKey: input.primaryKey?.length ? input.primaryKey : undefined,
      // Cleared explicitly, not left undefined: emptying the field in the form
      // must remove the partition spec, and `undefined` means "leave as-is".
      // DbNull is SQL NULL; JsonNull would store the JSON value `null`.
      partitionBy: input.partitionBy?.length ? input.partitionBy : Prisma.DbNull,
    },
  })
  revalidatePath('/data')
  return updated
}

export async function deleteIngestSource(id: string) {
  const userId = await getCurrentUserId()
  await ensureOwnership('ingestSource', id, userId)
  await db.ingestSource.delete({ where: { id } })
  revalidatePath('/data')
}

// ---------------------------------------------------------------------------
// Project targets
//
// The project's own connection is always target `dev`; rows here are the extra
// named targets (staging, prod, ...). Ownership runs through the project, not a
// createdBy column, so these cannot use ensureOwnership.
// ---------------------------------------------------------------------------

/** Same shape the backend enforces: it becomes a profiles.yml key and `dbt --target`. */
const TARGET_NAME_PATTERN = /^[a-z][a-z0-9_]{0,29}$/
const RESERVED_TARGET_NAMES = new Set(['dev'])

async function ensureProjectOwnership(projectId: string, userId: string) {
  const project = await db.dbtProject.findFirst({
    where: { id: projectId, createdBy: userId, deletedAt: null },
    select: { id: true },
  })
  if (!project) throw new Error('Not found or not authorized')
}

export type ProjectTargetInput = {
  projectId: string
  name: string
  connectionId: string
}

export async function getProjectTargets(projectId: string) {
  const userId = await getCurrentUserId()
  await ensureProjectOwnership(projectId, userId)
  return db.projectTarget.findMany({
    where: { projectId },
    include: { connection: { select: { id: true, name: true, connectionType: true } } },
    orderBy: { name: 'asc' },
  })
}

function validateProjectTarget(input: ProjectTargetInput) {
  const name = input.name?.trim() ?? ''
  if (!TARGET_NAME_PATTERN.test(name)) {
    throw new Error(
      'Target name must start with a lowercase letter and use only lowercase letters, digits and underscores (max 30 characters)',
    )
  }
  if (RESERVED_TARGET_NAMES.has(name)) {
    throw new Error("'dev' is the project's own connection and cannot be redefined here")
  }
  if (!input.connectionId) throw new Error('A connection is required')
  return name
}

export async function createProjectTarget(input: ProjectTargetInput) {
  const userId = await getCurrentUserId()
  const name = validateProjectTarget(input)
  await ensureProjectOwnership(input.projectId, userId)
  // Without this a user could point their prod target at someone else's warehouse.
  await ensureOwnership('connection', input.connectionId, userId)

  const created = await db.projectTarget.create({
    data: { projectId: input.projectId, name, connectionId: input.connectionId },
  })
  revalidatePath('/develop')
  return created
}

export async function updateProjectTarget(id: string, input: ProjectTargetInput) {
  const userId = await getCurrentUserId()
  const name = validateProjectTarget(input)
  const existing = await db.projectTarget.findUnique({ where: { id } })
  if (!existing) throw new Error('Not found or not authorized')
  await ensureProjectOwnership(existing.projectId, userId)
  await ensureOwnership('connection', input.connectionId, userId)

  const updated = await db.projectTarget.update({
    where: { id },
    data: { name, connectionId: input.connectionId },
  })
  revalidatePath('/develop')
  return updated
}

export async function deleteProjectTarget(id: string) {
  const userId = await getCurrentUserId()
  const existing = await db.projectTarget.findUnique({ where: { id } })
  if (!existing) throw new Error('Not found or not authorized')
  await ensureProjectOwnership(existing.projectId, userId)
  await db.projectTarget.delete({ where: { id } })
  revalidatePath('/develop')
}

// ---------------------------------------------------------------------------
// Schedules
//
// The cron expression is parsed for real by the runner (croniter). This layer
// rejects obvious junk so a typo fails while saving instead of silently never
// firing; /dbt/cron/preview is what the form uses to confirm the timing.
// ---------------------------------------------------------------------------

const RUN_COMMANDS = new Set<RunCommand>([
  'run',
  'test',
  'build',
  'compile',
  'docs',
  'deps',
  'clean',
  'seed',
  'snapshot',
  'source_freshness',
])

const MAX_SELECTOR_LENGTH = 500
// Mirrors _NAME_RE in dbt-runner/app/routers/lake.py, which is the enforcing side.
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

export type ScheduleInput = {
  projectId: string
  name: string
  command?: RunCommand
  selector?: string | null
  target?: string | null
  cron: string
  isActive?: boolean
  webhookUrl?: string | null
  publishSchema?: string | null
}

function validateSchedule(input: ScheduleInput) {
  const name = input.name?.trim() ?? ''
  if (!name) throw new Error('Name is required')
  if (!isPlausibleCron(input.cron)) {
    throw new Error('Cron must be 5 fields, e.g. "0 2 * * *" for 02:00 UTC daily')
  }
  const command = input.command ?? 'run'
  if (!RUN_COMMANDS.has(command)) throw new Error(`Unsupported command: ${command}`)

  const selector = input.selector?.trim() || null
  if (selector && selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error(`Selector must be ${MAX_SELECTOR_LENGTH} characters or fewer`)
  }

  const target = input.target?.trim() || null
  if (target && !TARGET_NAME_PATTERN.test(target)) {
    throw new Error('Target name must be lowercase letters, digits and underscores')
  }

  // The runner re-checks this against host_guard before every delivery; this is
  // the early, legible rejection, not the security boundary.
  const webhookUrl = input.webhookUrl?.trim() || null
  if (webhookUrl && !/^https?:\/\/.+/i.test(webhookUrl)) {
    throw new Error('Webhook URL must start with http:// or https://')
  }

  // Becomes a SQL identifier and a directory name in the Iceberg warehouse, so
  // it is validated here as well as in the runner.
  const publishSchema = input.publishSchema?.trim() || null
  if (publishSchema && !SCHEMA_NAME_PATTERN.test(publishSchema)) {
    throw new Error(
      'Publish schema must start with a letter or underscore and contain only letters, digits, _ or $',
    )
  }

  return {
    name,
    command,
    selector,
    target,
    cron: input.cron.trim(),
    webhookUrl,
    publishSchema,
  }
}

export async function getSchedules(projectId?: string) {
  const userId = await getCurrentUserId()
  return db.dbtSchedule.findMany({
    where: { createdBy: userId, ...(projectId ? { projectId } : {}) },
    include: { project: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createSchedule(input: ScheduleInput) {
  const userId = await getCurrentUserId()
  const clean = validateSchedule(input)
  await ensureProjectOwnership(input.projectId, userId)

  const created = await db.dbtSchedule.create({
    data: {
      projectId: input.projectId,
      ...clean,
      isActive: input.isActive ?? true,
      createdBy: userId,
      // Left null on purpose: the runner arms it on its first tick, which is
      // also what stops a schedule from firing the instant it is saved.
      nextRunAt: null,
    },
  })
  revalidatePath('/orchestrate')
  return created
}

export async function updateSchedule(id: string, input: ScheduleInput) {
  const userId = await getCurrentUserId()
  const clean = validateSchedule(input)
  await ensureOwnership('dbtSchedule', id, userId)
  await ensureProjectOwnership(input.projectId, userId)

  const existing = await db.dbtSchedule.findUnique({ where: { id } })
  const updated = await db.dbtSchedule.update({
    where: { id },
    data: {
      projectId: input.projectId,
      ...clean,
      isActive: input.isActive ?? true,
      // A changed cron must not keep the old due time, or the next fire is
      // computed from a schedule that no longer exists.
      nextRunAt: existing?.cron === clean.cron ? existing?.nextRunAt : null,
    },
  })
  revalidatePath('/orchestrate')
  return updated
}

export async function deleteSchedule(id: string) {
  const userId = await getCurrentUserId()
  await ensureOwnership('dbtSchedule', id, userId)
  await db.dbtSchedule.delete({ where: { id } })
  revalidatePath('/orchestrate')
}
