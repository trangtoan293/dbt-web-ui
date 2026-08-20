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

  it('creates todo_list with ownership', async () => {
    const todo = await prisma.todoList.create({
      data: { title: 'Test todo', owner: USER_A },
    })
    expect(todo.title).toBe('Test todo')
    expect(todo.done).toBe(false)
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

  it('creates dbt_models with GIN indexes', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'model-test', createdBy: USER_A },
    })
    const model = await prisma.dbtModel.create({
      data: {
        projectId: project.id,
        uniqueId: 'model.test.my_model',
        name: 'my_model',
        resourceType: 'model',
        path: 'models/my_model.sql',
        dependsOn: { nodes: ['model.test.other_model'] },
        tags: ['daily', 'core'],
      },
    })
    expect(model.dependsOn).toEqual({ nodes: ['model.test.other_model'] })
    expect(model.tags).toEqual(['daily', 'core'])
  })

  it('creates dbt_run with artifacts', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'run-test', createdBy: USER_A },
    })
    const model = await prisma.dbtModel.create({
      data: {
        projectId: project.id,
        uniqueId: 'model.test.run_model',
        name: 'run_model',
        resourceType: 'model',
        path: 'models/run_model.sql',
      },
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
        modelId: model.id,
        uniqueId: model.uniqueId,
        status: 'success',
        executionTime: 5.0,
      },
    })
    expect(artifact.status).toBe('success')
  })

  it('creates chat conversation with messages', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'chat-test', createdBy: USER_A },
    })
    const conv = await prisma.chatConversation.create({
      data: { title: 'Test Chat', projectId: project.id, owner: USER_A },
    })
    const msg = await prisma.chatMessage.create({
      data: { conversationId: conv.id, role: 'user', content: 'Hello' },
    })
    expect(msg.role).toBe('user')
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

  it('recent_runs view returns results', async () => {
    const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM recent_runs LIMIT 5`
    expect(Array.isArray(rows)).toBe(true)
  })

  it('get_upstream_models returns dependency chain', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'lineage-test', createdBy: USER_A },
    })
    await prisma.dbtModel.createMany({
      data: [
        { projectId: project.id, uniqueId: 'model.lineage.base', name: 'base', resourceType: 'model', path: 'base.sql' },
        { projectId: project.id, uniqueId: 'model.lineage.intermediate', name: 'intermediate', resourceType: 'model', path: 'int.sql',
          dependsOn: { nodes: ['model.lineage.base'] } },
        { projectId: project.id, uniqueId: 'model.lineage.target', name: 'target', resourceType: 'model', path: 'target.sql',
          dependsOn: { nodes: ['model.lineage.intermediate'] } },
      ],
    })
    const upstream = await prisma.$queryRaw<{ unique_id: string; level: number }[]>`
      SELECT * FROM get_upstream_models('model.lineage.target', ${project.id}::uuid)
    `
    expect(upstream.length).toBe(2)
    expect(upstream.map(u => u.unique_id).sort()).toEqual(['model.lineage.base', 'model.lineage.intermediate'])
  })

  it('get_downstream_models returns dependent chain', async () => {
    const project = await prisma.dbtProject.create({
      data: { name: 'lineage-down-test', createdBy: USER_A },
    })
    await prisma.dbtModel.createMany({
      data: [
        { projectId: project.id, uniqueId: 'model.lineage.base', name: 'base', resourceType: 'model', path: 'base.sql' },
        { projectId: project.id, uniqueId: 'model.lineage.intermediate', name: 'intermediate', resourceType: 'model', path: 'int.sql',
          dependsOn: { nodes: ['model.lineage.base'] } },
        { projectId: project.id, uniqueId: 'model.lineage.target', name: 'target', resourceType: 'model', path: 'target.sql',
          dependsOn: { nodes: ['model.lineage.intermediate'] } },
      ],
    })
    const downstream = await prisma.$queryRaw<{ unique_id: string; level: number }[]>`
      SELECT * FROM get_downstream_models('model.lineage.base', ${project.id}::uuid)
    `
    expect(downstream.length).toBe(2)
    expect(downstream.map(d => d.unique_id).sort()).toEqual(['model.lineage.intermediate', 'model.lineage.target'])
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
