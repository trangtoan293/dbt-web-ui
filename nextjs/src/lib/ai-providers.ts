import { Prisma } from '@prisma/client'

import { db } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/crypto'

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

/** Every wire protocol a declared route may name (llm-pi-ai supportedProtocols). */
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type Protocol = (typeof PROTOCOLS)[number]

/** Routes pi-ai ships a catalog for: a credential is all they need. */
export const CATALOG_ROUTES = ['deepseek', 'openai', 'anthropic', 'google', 'xai', 'groq', 'mistral'] as const

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
  const isCatalog = (CATALOG_ROUTES as readonly string[]).includes(route)
  const models = normalizeModels(input.models)
  if (!isCatalog && (!input.api || !input.baseUrl || models.length === 0)) {
    // The adapter refuses such a route where it is written; refuse it here so
    // the message names the missing field instead of arriving mid-prompt.
    return 'A provider pi-ai does not ship needs a protocol, a base URL and at least one model'
  }
  return null
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

  await db.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.aiProvider.updateMany({ where: { userId }, data: { isDefault: false } })
    }
    const data = {
      label: input.label?.trim() || null,
      apiKeyEnv,
      api: input.api?.trim() || null,
      baseUrl: input.baseUrl?.trim() || null,
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
    if (input.apiKey && input.apiKey.trim()) {
      const apiKeyEncrypted = encryptSecret(input.apiKey.trim())
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
    const models = normalizeModels(row.models as ProviderModel[] | null)
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
