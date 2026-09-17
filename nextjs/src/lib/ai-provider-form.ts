import { CATALOG_ROUTES } from "@/lib/ai-provider-definitions"

export interface ProviderModelView {
  id: string
}

export interface ProviderViewModel {
  route: string
  label: string | null
  apiKeyEnv: string
  api: string | null
  baseUrl: string | null
  models: ProviderModelView[]
  defaultModel: string | null
  isDefault: boolean
  credentialConfigured: boolean
  updatedAt: string
}

export interface ProviderDraft {
  connectionType: string
  editingRoute: string | null
  route: string
  label: string
  apiKeyEnv: string
  api: string
  baseUrl: string
  models: string
  defaultModel: string
  apiKey: string
  isDefault: boolean
  credentialConfigured: boolean
}

export interface ProviderFormInput {
  route: string
  label: string | null
  apiKeyEnv: string
  api: string | null
  baseUrl: string | null
  models: Array<{ id: string }>
  defaultModel: string | null
  isDefault: boolean
  apiKey: string | null
}

export function defaultApiKeyEnv(route: string): string {
  const cleaned = route.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned ? `${cleaned.toUpperCase()}_API_KEY` : ""
}

export function parseModelIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean))]
}

export function createProviderDraft(
  connectionType: string,
  provider?: ProviderViewModel,
): ProviderDraft {
  const route = provider?.route ?? (connectionType === "custom" ? "" : connectionType)
  return {
    connectionType: provider && !CATALOG_ROUTES.includes(provider.route) ? "custom" : connectionType,
    editingRoute: provider?.route ?? null,
    route,
    label: provider?.label ?? "",
    apiKeyEnv: provider?.apiKeyEnv ?? defaultApiKeyEnv(route),
    api: provider?.api ?? (connectionType === "custom" ? "openai-completions" : ""),
    baseUrl: provider?.baseUrl ?? "",
    models: provider?.models.map((model) => model.id).join(", ") ?? "",
    defaultModel: provider?.defaultModel ?? "",
    apiKey: "",
    isDefault: provider?.isDefault ?? false,
    credentialConfigured: provider?.credentialConfigured ?? false,
  }
}

export function draftToProviderInput(draft: ProviderDraft): ProviderFormInput {
  const route = draft.route.trim()
  const models = parseModelIds(draft.models).map((id) => ({ id }))
  return {
    route,
    label: draft.label.trim() || null,
    apiKeyEnv: draft.apiKeyEnv.trim() || defaultApiKeyEnv(route),
    api: draft.api || null,
    baseUrl: draft.baseUrl.trim() || null,
    models,
    defaultModel: draft.defaultModel.trim() || models[0]?.id || null,
    isDefault: draft.isDefault,
    apiKey: draft.apiKey.trim() || null,
  }
}

export function validateProviderDraft(draft: ProviderDraft): string | null {
  const isCustom = draft.connectionType === "custom"
  const route = draft.route.trim()
  if (isCustom && !route) return "Enter a connection name"
  if (!route) return "Choose a provider"
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(route)) {
    return "Connection name can use lowercase letters, numbers, and dashes only"
  }
  if (isCustom && !draft.baseUrl.trim()) return "Enter the API Base URL"
  if (draft.baseUrl.trim()) {
    try {
      const url = new URL(draft.baseUrl)
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme")
    } catch {
      return "API Base URL must be a valid http(s) URL"
    }
  }
  const models = parseModelIds(draft.models)
  if (isCustom && models.length === 0) return "Enter at least one model ID"
  if (!draft.apiKey.trim() && !draft.credentialConfigured) return "Enter an API key"
  if (draft.defaultModel.trim() && models.length > 0 && !models.includes(draft.defaultModel.trim())) {
    return "Default model must match one of the model IDs"
  }
  return null
}
