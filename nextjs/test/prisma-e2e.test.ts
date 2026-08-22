import { describe, it, expect } from 'vitest'
import { prisma, USER_A, USER_B } from './setup'

describe('Prisma Schema E2E', () => {
  it('connects to PostgreSQL', async () => {
    const result = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`
    expect(result[0].version).toContain('PostgreSQL')
  })

  it('users are pre-created by setup', async () => {
    const userA = await prisma.user.findUnique({ where: { id: USER_A } })
    expect(userA).toBeDefined()
    expect(userA!.email).toBe('user-a@test.com')

    const userB = await prisma.user.findUnique({ where: { id: USER_B } })
    expect(userB).toBeDefined()
  })

  it('enforces unique email', async () => {
    await expect(
      prisma.user.create({
        data: { id: '10000000-0000-0000-0000-000000000001', oidcSub: '10000000-0000-0000-0000-000000000001', email: 'user-a@test.com', name: 'Dup' },
      })
    ).rejects.toThrow()
  })

  it('creates dbt_project with ownership', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'test-project', createdBy: USER_A },
    })
    expect(project.name).toBe('test-project')
    expect(project.createdBy).toBe(USER_A)
  })

  it('creates dremio_source linked to project', async () => {
    const source = await prisma.dremioSource.create({
      data: {
        name: 'test-dremio',
        host: 'localhost',
        port: 32010,
        username: 'admin',
        tokenEncrypted: 'encrypted-token',
        createdBy: USER_A,
      },
    })
    const project = await prisma.dbtProject.create({
      data: { name: 'with-source', createdBy: USER_A, dremioSourceId: source.id },
    })
    expect(project.dremioSourceId).toBe(source.id)
  })

  it('creates connection with enum type', async () => {
    const conn = await prisma.connection.create({
      data: {
        name: 'test-pg',
        connectionType: 'postgresql',
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        username: 'user',
        createdBy: USER_A,
      },
    })
    expect(conn.connectionType).toBe('postgresql')
  })

  it('enforces foreign key cascade on user delete', async () => {
    const tempUserId = '20000000-0000-0000-0000-000000000001'
    await prisma.user.create({
      data: { id: tempUserId, oidcSub: tempUserId, email: 'temp@test.com' },
    })
    await prisma.dbtProject.create({
      data: { name: 'temp-project', createdBy: tempUserId },
    })
    await prisma.user.delete({ where: { id: tempUserId } })
    const projects = await prisma.dbtProject.findMany({ where: { createdBy: tempUserId } })
    expect(projects.length).toBe(0)
  })

  it('updated_at trigger fires on project update', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'trigger-test', createdBy: USER_A },
    })
    const originalUpdatedAt = project.updatedAt
    await new Promise(r => setTimeout(r, 100))

    const updated = await prisma.dbtProject.update({
      where: { id: project.id },
      data: { name: 'trigger-test-renamed' },
    })
    expect(updated.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime())
  })

  it('creates dbt_run with artifacts', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'run-test', createdBy: USER_A },
    })
    const run = await prisma.dbtRun.create({
      data: {
        projectId: project.id,
        command: 'build',
        status: 'success',
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 5000n,
        modelsTotal: 1,
        modelsSuccess: 1,
      },
    })
    expect(run.status).toBe('success')

    const artifact = await prisma.dbtRunArtifact.create({
      data: {
        runId: run.id,
        uniqueId: 'model.test.run_model',
        status: 'success',
        executionTime: 5.0,
      },
    })
    expect(artifact.status).toBe('success')
  })

  it('ownership isolation: user B cannot see user A rows', async () => {
    await prisma.dbtProject.create({
      data: { name: 'a-project', createdBy: USER_A },
    })
    const projectA = await prisma.dbtProject.findFirst({ where: { createdBy: USER_A } })
    expect(projectA).toBeDefined()
    const projectB = await prisma.dbtProject.findFirst({ where: { createdBy: USER_B } })
    expect(projectB).toBeNull()
  })

  it('creates a schedule with the source_freshness command', async () => {
    // source_freshness was added to the run_command enum for scheduling
    // `dbt source freshness`; if the enum value is missing this throws.
    const project = await prisma.dbtProject.create({
      data: { name: 'sched-test', createdBy: USER_A },
    })
    const schedule = await prisma.dbtSchedule.create({
      data: {
        projectId: project.id,
        name: 'nightly',
        command: 'source_freshness',
        cron: '0 2 * * *',
        createdBy: USER_A,
      },
    })
    expect(schedule.command).toBe('source_freshness')
    expect(schedule.isActive).toBe(true)
    // Left unarmed on creation, so saving a schedule never fires it immediately.
    expect(schedule.nextRunAt).toBeNull()
  })

  it('enforces one schedule name per project', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'sched-unique', createdBy: USER_A },
    })
    const data = {
      projectId: project.id,
      name: 'nightly',
      cron: '0 2 * * *',
      createdBy: USER_A,
    }
    await prisma.dbtSchedule.create({ data })
    await expect(prisma.dbtSchedule.create({ data })).rejects.toThrow()
  })

  it('creates a named project target', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'target-test', createdBy: USER_A },
    })
    const connection = await prisma.connection.create({
      data: {
        name: 'prod-wh',
        connectionType: 'postgresql',
        host: 'prod-db',
        port: 5432,
        database: 'prodwh',
        username: 'u',
        createdBy: USER_A,
      },
    })
    const target = await prisma.projectTarget.create({
      data: { projectId: project.id, name: 'prod', connectionId: connection.id },
    })
    expect(target.name).toBe('prod')
  })

  it('refuses to delete a connection a target still points at', async () => {
    // RESTRICT, not CASCADE: losing a target silently would leave the project
    // rendering a profile that no longer has the output its runs name.
    const project = await prisma.dbtProject.create({
      data: { name: 'target-restrict', createdBy: USER_A },
    })
    const connection = await prisma.connection.create({
      data: {
        name: 'restrict-wh',
        connectionType: 'postgresql',
        host: 'db',
        port: 5432,
        database: 'wh',
        username: 'u',
        createdBy: USER_A,
      },
    })
    await prisma.projectTarget.create({
      data: { projectId: project.id, name: 'prod', connectionId: connection.id },
    })
    await expect(prisma.connection.delete({ where: { id: connection.id } })).rejects.toThrow()
  })

  it('creates an ingest run and cascades it with its source', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'ingest-run-test', createdBy: USER_A },
    })
    const connection = await prisma.connection.create({
      data: {
        name: 'ingest-src',
        connectionType: 'postgresql',
        host: 'src-db',
        port: 5432,
        database: 'crm',
        username: 'u',
        createdBy: USER_A,
      },
    })
    const source = await prisma.ingestSource.create({
      data: {
        projectId: project.id,
        sourceConnectionId: connection.id,
        name: 'CRM sync',
        dataset: 'raw_crm',
        tables: ['customers'],
        createdBy: USER_A,
      },
    })
    const run = await prisma.ingestRun.create({
      data: {
        sourceId: source.id,
        projectId: project.id,
        status: 'success',
        startedAt: new Date(),
        rowsLoaded: 10,
        tables: { customers: 10 },
      },
    })
    expect(run.rowsLoaded).toBe(10)

    await prisma.ingestSource.delete({ where: { id: source.id } })
    expect(await prisma.ingestRun.findUnique({ where: { id: run.id } })).toBeNull()
  })

  it('updated_at trigger fires on dremio_source update', async () => {
    const source = await prisma.dremioSource.create({
      data: { name: 'dremio-upd', host: 'localhost', port: 32010, username: 'admin', tokenEncrypted: 'tok', createdBy: USER_A },
    })
    await new Promise(r => setTimeout(r, 100))
    const updated = await prisma.dremioSource.update({
      where: { id: source.id },
      data: { username: 'admin2' },
    })
    expect(updated.updatedAt.getTime()).toBeGreaterThan(source.updatedAt.getTime())
  })

  it('updated_at trigger fires on connection update', async () => {
    const conn = await prisma.connection.create({
      data: { name: 'conn-upd', connectionType: 'postgresql', host: 'localhost', port: 5432, database: 'db', username: 'u', createdBy: USER_A },
    })
    await new Promise(r => setTimeout(r, 100))
    const updated = await prisma.connection.update({
      where: { id: conn.id },
      data: { username: 'u2' },
    })
    expect(updated.updatedAt.getTime()).toBeGreaterThan(conn.updatedAt.getTime())
  })
})
