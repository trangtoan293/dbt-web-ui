import { Prisma } from '@prisma/client'

import { db } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/crypto'
import {
  CATALOG_ROUTES,
  PROTOCOLS,
  PROVIDER_PRESETS,
  type Protocol,
} from '@/lib/ai-provider-definitions'

export { CATALOG_ROUTES, PROTOCOLS, PROVIDER_PRESETS }

/**
 * Model providers for the dbt assistant, in the shape the harness itself uses.
 *
 * The harness's adapter (`llm-pi-ai`) takes a dict of routes: a route pi-ai
 * ships a catalog for needs only a credential reference, while a gateway it does
 * not ship declares its protocol, endpoint and models. Storing exactly that -
 * and keeping the secret in a separate table the way the harness keeps its
 * credential store separate from settings - is what makes any provider work
 * here without another code change.
 *
 * Server-only, and deliberately not a server action: an action returning a
 * decrypted key would be callable from the browser.
 */

export interface ProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface ProviderInput {
  route: string
  label?: string | null
  apiKeyEnv?: string | null
  api?: string | null
  baseUrl?: string | null
  models?: ProviderModel[] | null
  defaultModel?: string | null
  isDefault?: boolean
  /** Optional: set or replace the credential this route resolves. */
  apiKey?: string | null
}

export interface ProviderView {
  route: string
  label: string | null
  apiKeyEnv: string
  api: string | null
  baseUrl: string | null
  models: ProviderModel[]
  defaultModel: string | null
  isDefault: boolean
  /** Whether a credential is stored for this route's reference. */
  credentialConfigured: boolean
  updatedAt: string
}

/** The credential reference a route defaults to, e.g. openai -> OPENAI_API_KEY. */
export function defaultApiKeyEnv(route: string): string {
  const cleaned = route.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${cleaned.toUpperCase()}_API_KEY`
}

/**
 * The models a route must declare to `llm-pi-ai`.
 *
 * pi-ai ships a catalog for each known route, but a catalog is a snapshot: a
 * model the provider has added since is refused with "provider X has no
 * configured model Y", even though the provider serves it. The session is
 * started on this row's own default, so that default is always declared.
 *
 * ponytail: the id alone, with no context window - pi-ai falls back to its own
 * defaults for that. Carry the real numbers here if compaction turns out wrong.
 */
export function declaredModels(
  models: ProviderModel[],
  defaultModel: string | null | undefined,
): ProviderModel[] {
  const chosen = defaultModel?.trim()
  if (!chosen || models.some((model) => model.id === chosen)) return models
  return [...models, { id: chosen }]
}

function normalizeModels(models: ProviderModel[] | null | undefined): ProviderModel[] {
  if (!Array.isArray(models)) return []
  const seen = new Set<string>()
  return models
    .map((model) => ({
      id: String(model?.id ?? '').trim(),
      ...(model?.name ? { name: String(model.name) } : {}),
      ...(model?.contextWindow ? { contextWindow: Number(model.contextWindow) } : {}),
      ...(model?.maxTokens ? { maxTokens: Number(model.maxTokens) } : {}),
    }))
    .filter((model) => {
      if (!model.id || seen.has(model.id)) return false
      seen.add(model.id)
      return true
    })
}

/** Reject a route or reference that would not survive the harness's own schema. */
export function validateProvider(input: ProviderInput): string | null {
  const route = input.route?.trim() ?? ''
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(route)) {
    return 'Provider id must be lowercase letters, digits or dashes'
  }
  const apiKeyEnv = (input.apiKeyEnv ?? defaultApiKeyEnv(route)).trim()
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(apiKeyEnv)) {
    return 'Credential reference must look like OPENAI_API_KEY'
  }
  if (input.api && !PROTOCOLS.includes(input.api as Protocol)) {
    return `Protocol must be one of ${PROTOCOLS.join(', ')}`
  }
  if (input.baseUrl) {
    try {
      const url = new URL(input.baseUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
    } catch {
      return 'Base URL must be a valid http(s) URL'
    }
  }
  const isCatalog = CATALOG_ROUTES.includes(route)
  const models = normalizeModels(input.models)
  if (!isCatalog && !input.api) {
    return 'Protocol is required for a custom provider'
  }
  if (!isCatalog && !input.baseUrl) {
    return 'Base URL is required for a custom provider'
  }
  if (!isCatalog && models.length === 0) {
    return 'At least one model ID is required for a custom provider'
  }
  const defaultModel = input.defaultModel?.trim()
  if (!isCatalog && defaultModel && !models.some((model) => model.id === defaultModel)) {
    return 'Default model must match one of the configured model IDs'
  }
  return null
}

/** Resolve a write-only credential for a server-side connection check. */
export async function readProviderCredentialForTest(
  userId: string,
  route: string,
  credentialName: string,
  baseUrl: string | null | undefined,
): Promise<string | null> {
  const provider = await db.aiProvider.findUnique({
    where: { userId_route: { userId, route } },
  })
  // A write-only saved key may only be sent back to the exact endpoint it was
  // saved for. Otherwise a stolen browser session could point a connection at
  // an attacker-controlled URL and use this check to recover the secret.
  if (
    !provider
    || provider.apiKeyEnv !== credentialName
    || (provider.baseUrl ?? null) !== (baseUrl?.trim() || null)
  ) {
    return null
  }
  const row = await db.aiCredential.findUnique({
    where: { userId_credentialName: { userId, credentialName } },
  })
  if (!row) return null
  try {
    return decryptSecret(row.apiKeyEncrypted)
  } catch {
    return null
  }
}

export async function listProviders(userId: string): Promise<ProviderView[]> {
  const [rows, credentials] = await Promise.all([
    db.aiProvider.findMany({ where: { userId }, orderBy: { route: 'asc' } }),
    db.aiCredential.findMany({ where: { userId }, select: { credentialName: true } }),
  ])
  const configured = new Set(credentials.map((row) => row.credentialName))
  return rows.map((row) => ({
    route: row.route,
    label: row.label,
    apiKeyEnv: row.apiKeyEnv,
    api: row.api,
    baseUrl: row.baseUrl,
    models: normalizeModels(row.models as ProviderModel[] | null),
    defaultModel: row.defaultModel,
    isDefault: row.isDefault,
    credentialConfigured: configured.has(row.apiKeyEnv),
    updatedAt: row.updatedAt.toISOString(),
  }))
}

export async function upsertProvider(userId: string, input: ProviderInput): Promise<ProviderView[]> {
  const problem = validateProvider(input)
  if (problem) throw new Error(problem)

  const route = input.route.trim()
  const apiKeyEnv = (input.apiKeyEnv ?? defaultApiKeyEnv(route)).trim()
  const models = normalizeModels(input.models)
  const baseUrl = input.baseUrl?.trim() || null
  const suppliedApiKey = input.apiKey?.trim() || null

  const [existingProvider, targetCredential] = await Promise.all([
    db.aiProvider.findUnique({ where: { userId_route: { userId, route } } }),
    db.aiCredential.findUnique({
      where: { userId_credentialName: { userId, credentialName: apiKeyEnv } },
      select: { id: true },
    }),
  ])
  if (!existingProvider && !suppliedApiKey) {
    throw new Error('API key is required when creating a personal AI connection')
  }
  const movesStoredCredential = targetCredential && (
    !existingProvider
    || existingProvider.apiKeyEnv !== apiKeyEnv
    || (existingProvider.baseUrl ?? null) !== baseUrl
  )
  if (movesStoredCredential && !suppliedApiKey) {
    throw new Error('Re-enter the API key when changing its connection or Base URL')
  }

  await db.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.aiProvider.updateMany({ where: { userId }, data: { isDefault: false } })
    }
    const data = {
      label: input.label?.trim() || null,
      apiKeyEnv,
      api: input.api?.trim() || null,
      baseUrl,
      // Prisma spells "store SQL NULL in a nullable Json column" explicitly, and
      // an empty list means "serve the route's own catalog" rather than "no
      // models", so it must be that null and not [].
      models: models.length > 0 ? (models as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      defaultModel: input.defaultModel?.trim() || models[0]?.id || null,
      isDefault: input.isDefault ?? false,
    }
    await tx.aiProvider.upsert({
      where: { userId_route: { userId, route } },
      create: { userId, route, ...data },
      update: data,
    })
    if (suppliedApiKey) {
      const apiKeyEncrypted = encryptSecret(suppliedApiKey)
      await tx.aiCredential.upsert({
        where: { userId_credentialName: { userId, credentialName: apiKeyEnv } },
        create: { userId, credentialName: apiKeyEnv, provider: route, apiKeyEncrypted },
        update: { provider: route, apiKeyEncrypted },
      })
    }
  })

  return listProviders(userId)
}

export async function deleteProvider(userId: string, route: string): Promise<ProviderView[]> {
  const row = await db.aiProvider.findUnique({ where: { userId_route: { userId, route } } })
  if (row) {
    await db.$transaction([
      db.aiProvider.delete({ where: { id: row.id } }),
      // The credential goes with the only route that referenced it.
      db.aiCredential.deleteMany({ where: { userId, credentialName: row.apiKeyEnv } }),
    ])
  }
  return listProviders(userId)
}

export interface ResolvedRoutes {
  /** The `llm-pi-ai` providers dict, exactly as that adapter's config takes it. */
  providers: Record<string, Record<string, unknown>>
  /** Credential reference -> secret, for the harness process environment. */
  credentials: Record<string, string>
  /** The route and model a new session starts on. */
  route: string | null
  model: string | null
}

/**
 * Everything the agent needs to serve this user's own providers.
 *
 * Shaped for the harness rather than for us: `providers` is the adapter's dict,
 * carrying credential *references*, and the secrets travel beside it so they
 * never enter a config file.
 */
export async function resolveRoutes(userId: string): Promise<ResolvedRoutes> {
  const [rows, credentials] = await Promise.all([
    db.aiProvider.findMany({ where: { userId } }),
    db.aiCredential.findMany({ where: { userId } }),
  ])

  const secrets: Record<string, string> = {}
  for (const credential of credentials) {
    try {
      secrets[credential.credentialName] = decryptSecret(credential.apiKeyEncrypted)
    } catch {
      // Encrypted under a different APP_ENCRYPTION_KEY: treat as absent so the
      // user is told to re-enter it rather than seeing an opaque failure.
    }
  }

  const providers: Record<string, Record<string, unknown>> = {}
  for (const row of rows) {
    const models = declaredModels(normalizeModels(row.models as ProviderModel[] | null), row.defaultModel)
    providers[row.route] = {
      apiKeyEnv: row.apiKeyEnv,
      ...(row.label ? { displayName: row.label } : {}),
      ...(row.api ? { api: row.api } : {}),
      ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
      ...(models.length > 0 ? { models } : {}),
    }
  }

  const chosen = rows.find((row) => row.isDefault) ?? rows[0]
  const chosenModels = chosen ? normalizeModels(chosen.models as ProviderModel[] | null) : []

  return {
    providers,
    credentials: secrets,
    route: chosen?.route ?? null,
    model: chosen?.defaultModel ?? chosenModels[0]?.id ?? null,
  }
}
