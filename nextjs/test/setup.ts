import { beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

const databaseUrl = process.env.DATABASE_URL || ''

// Safety guard: this setup wipes EVERY table in beforeEach. Refuse to run unless
// DATABASE_URL clearly targets a dedicated test database, so a misconfigured run
// can never destroy dev/prod data.
if (!/test/i.test(databaseUrl)) {
  throw new Error(
    `[test/setup.ts] Refusing to run: DATABASE_URL must point at a dedicated test database ` +
      `(name must contain "test"). Got: "${databaseUrl || '(empty)'}". ` +
      `Set it via nextjs/.env.test (e.g. .../dbtcraft_test).`,
  )
}

export const prisma = new PrismaClient({
  datasourceUrl: databaseUrl,
})

export const USER_A = '00000000-0000-0000-0000-000000000001'
export const USER_B = '00000000-0000-0000-0000-000000000002'

beforeEach(async () => {
  // Clean data but not users
  await prisma.dbtRunArtifact.deleteMany()
  await prisma.dbtRun.deleteMany()
  await prisma.dbtEnvironmentVariable.deleteMany()
  await prisma.gitCredential.deleteMany()
  await prisma.dbtProject.deleteMany()
  await prisma.dremioSource.deleteMany()
  await prisma.connection.deleteMany()
  await prisma.aiProvider.deleteMany()
  await prisma.aiCredential.deleteMany()
  await prisma.user.deleteMany()

  // Always recreate test users
  await prisma.user.createMany({
    data: [
      { id: USER_A, oidcSub: USER_A, email: 'user-a@test.com', name: 'User A' },
      { id: USER_B, oidcSub: USER_B, email: 'user-b@test.com', name: 'User B' },
    ],
    skipDuplicates: true,
  })
})

afterAll(async () => {
  await prisma.$disconnect()
})
