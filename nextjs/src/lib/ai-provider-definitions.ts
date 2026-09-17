export const PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const
export type Protocol = (typeof PROTOCOLS)[number]

export type ProviderAuth = "bearer" | "anthropic" | "google"

export interface ProviderPreset {
  route: string
  label: string
  description: string
  apiKeyPlaceholder: string
  baseUrl: string
  auth: ProviderAuth
}

/**
 * Providers whose model catalogs are built into pi-ai. The UI uses the same
 * list, with human-facing copy and the public endpoint needed for a connection
 * check, so setup guidance cannot drift away from what the agent accepts.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    route: "openai",
    label: "OpenAI",
    description: "GPT models from the OpenAI API",
    apiKeyPlaceholder: "sk-proj-…",
    baseUrl: "https://api.openai.com/v1",
    auth: "bearer",
  },
  {
    route: "anthropic",
    label: "Anthropic",
    description: "Claude models from the Anthropic API",
    apiKeyPlaceholder: "sk-ant-…",
    baseUrl: "https://api.anthropic.com/v1",
    auth: "anthropic",
  },
  {
    route: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek chat and reasoning models",
    apiKeyPlaceholder: "sk-…",
    baseUrl: "https://api.deepseek.com",
    auth: "bearer",
  },
  {
    route: "google",
    label: "Google Gemini",
    description: "Gemini models from Google AI",
    apiKeyPlaceholder: "AIza…",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth: "google",
  },
  {
    route: "xai",
    label: "xAI",
    description: "Grok models from the xAI API",
    apiKeyPlaceholder: "xai-…",
    baseUrl: "https://api.x.ai/v1",
    auth: "bearer",
  },
  {
    route: "groq",
    label: "Groq",
    description: "Hosted open models on GroqCloud",
    apiKeyPlaceholder: "gsk_…",
    baseUrl: "https://api.groq.com/openai/v1",
    auth: "bearer",
  },
  {
    route: "mistral",
    label: "Mistral AI",
    description: "Mistral models from La Plateforme",
    apiKeyPlaceholder: "API key",
    baseUrl: "https://api.mistral.ai/v1",
    auth: "bearer",
  },
] as const

export const CATALOG_ROUTES = PROVIDER_PRESETS.map((provider) => provider.route)

export function findProviderPreset(route: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((provider) => provider.route === route)
}
