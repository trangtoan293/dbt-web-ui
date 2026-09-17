import { afterEach, describe, expect, it, vi } from "vitest"

const dbMock = vi.hoisted(() => ({
  user: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock("@/lib/db", () => ({ db: dbMock }))

vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}))

vi.mock("next-auth/providers/credentials", () => ({
  default: (options: Record<string, unknown>) => options,
}))

async function loadAuthCallbacks(authDisabled: boolean) {
  vi.stubEnv("AUTH_DISABLED", authDisabled ? "true" : "false")
  vi.resetModules()
  const authModule = await import("../src/lib/auth")
  return authModule.authCallbacks
}

describe("auth user reconciliation", () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("replaces a stale local user id after the users row is restored", async () => {
    const replacementId = "11111111-1111-1111-1111-111111111111"
    dbMock.user.upsert.mockResolvedValue({ id: replacementId })
    const callbacks = await loadAuthCallbacks(true)

    const token = await callbacks.jwt({
      token: {
        userId: "22222222-2222-2222-2222-222222222222",
      },
    } as unknown as Parameters<typeof callbacks.jwt>[0])

    expect(dbMock.user.upsert).toHaveBeenCalledWith({
      where: { oidcSub: "local-user" },
      update: { name: "Local User" },
      create: {
        oidcSub: "local-user",
        email: "local@dbt-craft.local",
        name: "Local User",
      },
    })
    expect(token.userId).toBe(replacementId)
  })

  it("replaces a stale OIDC user id without requiring a new login", async () => {
    const replacementId = "33333333-3333-3333-3333-333333333333"
    dbMock.user.upsert.mockResolvedValue({ id: replacementId })
    const callbacks = await loadAuthCallbacks(false)

    const token = await callbacks.jwt({
      token: {
        sub: "customer-sub",
        email: "customer@example.com",
        name: "Customer",
        userId: "44444444-4444-4444-4444-444444444444",
        accessToken: "access-token",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    } as unknown as Parameters<typeof callbacks.jwt>[0])

    expect(dbMock.user.upsert).toHaveBeenCalledWith({
      where: { oidcSub: "customer-sub" },
      update: { name: "Customer" },
      create: {
        oidcSub: "customer-sub",
        email: "customer@example.com",
        name: "Customer",
      },
    })
    expect(token.userId).toBe(replacementId)
  })
})
