import { prisma, USER_A, USER_B } from './setup'
import {
  defaultApiKeyEnv,
  deleteProvider,
  listProviders,
  resolveRoutes,
  upsertProvider,
  validateProvider,
} from '@/lib/ai-providers'

// crypto.ts reads this at call time. Set here rather than in .env.test so the
// test is self-contained: it is exercising encryption, not a local setup.
process.env.APP_ENCRYPTION_KEY ||= 'test-only-key-material'

async function seedUsers() {
  await prisma.user.createMany({
    data: [
      { id: USER_A, oidcSub: 'sub-a', email: 'a@example.com' },
      { id: USER_B, oidcSub: 'sub-b', email: 'b@example.com' },
    ],
    skipDuplicates: true,
  })
}

describe('assistant model providers', () => {
  beforeEach(seedUsers)

  it('derives the credential reference the harness resolves', () => {
    expect(defaultApiKeyEnv('openai')).toBe('OPENAI_API_KEY')
    expect(defaultApiKeyEnv('acme-gateway')).toBe('ACME_GATEWAY_API_KEY')
  })

  it('accepts a catalog route with nothing but a key', () => {
    expect(validateProvider({ route: 'openai', apiKey: 'sk-x' })).toBeNull()
  })

  it('refuses a declared route that cannot be served', () => {
    // The adapter refuses such a profile where it is written; refusing here
    // means the message names the missing field instead of arriving mid-prompt.
    expect(validateProvider({ route: 'acme' })).toMatch(/protocol, a base URL and at least one model/)
    expect(validateProvider({
      route: 'acme', api: 'openai-completions', baseUrl: 'https://g.example/v1',
      models: [{ id: 'acme-large' }],
    })).toBeNull()
  })

  it('refuses shapes the harness schema would reject', () => {
    expect(validateProvider({ route: 'Bad Route' })).toMatch(/lowercase/)
    expect(validateProvider({ route: 'openai', apiKeyEnv: 'lower_case' })).toMatch(/OPENAI_API_KEY/)
    expect(validateProvider({ route: 'openai', api: 'grpc' })).toMatch(/Protocol must be/)
    expect(validateProvider({ route: 'openai', baseUrl: 'not a url' })).toMatch(/Base URL/)
  })

  it('stores the key encrypted under the reference its route names', async () => {
    await upsertProvider(USER_A, { route: 'openai', apiKey: 'sk-user-secret', isDefault: true })

    const row = await prisma.aiCredential.findFirstOrThrow({ where: { userId: USER_A } })
    expect(row.credentialName).toBe('OPENAI_API_KEY')
    expect(row.apiKeyEncrypted).not.toContain('sk-user-secret')
    expect(row.apiKeyEncrypted.startsWith('v1:gcm:')).toBe(true)
  })

  it('reports whether a route has a key, never the key', async () => {
    await upsertProvider(USER_A, { route: 'openai', apiKey: 'sk-user-secret' })
    await upsertProvider(USER_A, {
      route: 'acme', api: 'openai-completions', baseUrl: 'https://g.example/v1',
      models: [{ id: 'acme-large' }],
    })

    const providers = await listProviders(USER_A)

    expect(providers.map((p) => [p.route, p.credentialConfigured])).toEqual([
      ['acme', false], ['openai', true],
    ])
    expect(JSON.stringify(providers)).not.toContain('sk-user-secret')
  })

  it('keeps one default route', async () => {
    await upsertProvider(USER_A, { route: 'openai', apiKey: 'sk-a', isDefault: true })
    await upsertProvider(USER_A, { route: 'anthropic', apiKey: 'sk-b', isDefault: true })

    const providers = await listProviders(USER_A)

    expect(providers.filter((p) => p.isDefault).map((p) => p.route)).toEqual(['anthropic'])
  })

  it('resolves the adapter config the agent needs, with secrets beside it', async () => {
    await upsertProvider(USER_A, {
      route: 'acme', label: 'Acme Gateway', api: 'openai-completions',
      baseUrl: 'https://gateway.acme.example/v1',
      models: [{ id: 'acme-large', contextWindow: 65536 }, { id: 'acme-think' }],
      apiKey: 'sk-acme', isDefault: true,
    })

    const resolved = await resolveRoutes(USER_A)

    // Exactly the shape llm-pi-ai's `providers` dict takes.
    expect(resolved.providers).toEqual({
      acme: {
        apiKeyEnv: 'ACME_API_KEY',
        displayName: 'Acme Gateway',
        api: 'openai-completions',
        baseURL: 'https://gateway.acme.example/v1',
        models: [{ id: 'acme-large', contextWindow: 65536 }, { id: 'acme-think' }],
      },
    })
    expect(resolved.credentials).toEqual({ ACME_API_KEY: 'sk-acme' })
    expect(resolved.route).toBe('acme')
    expect(resolved.model).toBe('acme-large')
  })

  it('leaves a plain stored key usable without a provider row', async () => {
    // What an earlier release stored: a DeepSeek key and nothing else. The route
    // then comes from the deployment's own default, as it did before.
    await prisma.aiCredential.create({
      data: {
        userId: USER_A, credentialName: 'DEEPSEEK_API_KEY', provider: 'deepseek-official',
        apiKeyEncrypted: (await import('@/lib/crypto')).encryptSecret('sk-legacy'),
      },
    })

    const resolved = await resolveRoutes(USER_A)

    expect(resolved.credentials).toEqual({ DEEPSEEK_API_KEY: 'sk-legacy' })
    expect(resolved.providers).toEqual({})
    expect(resolved.route).toBeNull()
  })

  it('keeps one user out of another user routes and keys', async () => {
    await upsertProvider(USER_A, { route: 'openai', apiKey: 'sk-a' })

    expect(await listProviders(USER_B)).toEqual([])
    expect(await resolveRoutes(USER_B)).toEqual({
      providers: {}, credentials: {}, route: null, model: null,
    })
  })

  it('deleting a route takes its credential with it', async () => {
    await upsertProvider(USER_A, { route: 'openai', apiKey: 'sk-a' })

    const remaining = await deleteProvider(USER_A, 'openai')

    expect(remaining).toEqual([])
    expect(await prisma.aiCredential.count({ where: { userId: USER_A } })).toBe(0)
  })

  it('treats a key it cannot decrypt as absent instead of failing the prompt', async () => {
    await upsertProvider(USER_A, { route: 'openai', apiKey: 'sk-a' })
    await prisma.aiCredential.updateMany({
      where: { userId: USER_A },
      data: { apiKeyEncrypted: 'v1:gcm:AAAA:BBBB' },
    })

    const resolved = await resolveRoutes(USER_A)

    expect(resolved.credentials).toEqual({})
    // The route still reports a stored key: the user must be told to re-enter it.
    expect((await listProviders(USER_A))[0].credentialConfigured).toBe(true)
  })

  it('goes away with the user', async () => {
    await upsertProvider(USER_A, { route: 'openai', apiKey: 'sk-a' })
    await prisma.user.delete({ where: { id: USER_A } })

    expect(await prisma.aiProvider.count()).toBe(0)
    expect(await prisma.aiCredential.count()).toBe(0)
  })
})
