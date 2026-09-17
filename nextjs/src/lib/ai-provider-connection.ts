import { findProviderPreset, type ProviderAuth } from "@/lib/ai-provider-definitions"

export interface ProviderConnectionConfig {
  route: string
  apiKey: string
  baseUrl?: string | null
  defaultModel?: string | null
}

export interface ProviderConnectionResult {
  status: "connected" | "warning" | "error"
  message: string
  latencyMs: number
  modelCount?: number
  modelMatched?: boolean
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/models`
}

function authenticationHeaders(auth: ProviderAuth, apiKey: string): Record<string, string> {
  if (auth === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }
  }
  if (auth === "google") return { "x-goog-api-key": apiKey }
  return { Authorization: `Bearer ${apiKey}` }
}

function modelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return []
  const body = payload as { data?: unknown; models?: unknown }
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
  return rows
    .map((row) => {
      if (!row || typeof row !== "object") return ""
      const value = "id" in row ? row.id : "name" in row ? row.name : ""
      return typeof value === "string" ? value.replace(/^models\//, "") : ""
    })
    .filter(Boolean)
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

function errorMessage(status: number, isCustom: boolean): string {
  if (status === 401 || status === 403) {
    return `Authentication failed (${status}). Check that the API key is correct and has model access.`
  }
  if (status === 404 && isCustom) {
    return "Models endpoint not found (404). For most OpenAI-compatible servers, Base URL should end in /v1."
  }
  if (status === 429) {
    return "The provider accepted the request but rate-limited it (429). Check quota and try again."
  }
  return `Provider returned HTTP ${status}. Check the Base URL and provider status.`
}

/**
 * Verify reachability and credentials without generating content. A models
 * request is intentionally used instead of a chat request, so the check does
 * not spend inference tokens or add test prompts to provider logs.
 */
export async function checkProviderConnection(
  config: ProviderConnectionConfig,
  fetcher: Fetcher = fetch,
  timeoutMs = 10_000,
): Promise<ProviderConnectionResult> {
  const startedAt = Date.now()
  const preset = findProviderPreset(config.route)
  const baseUrl = config.baseUrl?.trim() || preset?.baseUrl
  const isCustom = !preset

  if (!baseUrl) {
    return {
      status: "error",
      message: "Base URL is required for a custom OpenAI-compatible connection.",
      latencyMs: elapsedSince(startedAt),
    }
  }
  if (!config.apiKey.trim()) {
    return {
      status: "error",
      message: "API key is required before the connection can be checked.",
      latencyMs: elapsedSince(startedAt),
    }
  }

  try {
    const response = await fetcher(modelsUrl(baseUrl), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...authenticationHeaders(preset?.auth ?? "bearer", config.apiKey),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      return {
        status: "error",
        message: errorMessage(response.status, isCustom),
        latencyMs: elapsedSince(startedAt),
      }
    }

    const contentType = response.headers.get("content-type") ?? ""
    const payload = contentType.includes("json") ? await response.json().catch(() => null) : null
    const models = modelIds(payload)
    const selectedModel = config.defaultModel?.trim()
    const matched = selectedModel && models.length > 0 ? models.includes(selectedModel) : undefined

    if (matched === false) {
      return {
        status: "warning",
        message: `Connected, but model “${selectedModel}” was not returned by this provider. Check the model ID.`,
        latencyMs: elapsedSince(startedAt),
        modelCount: models.length,
        modelMatched: false,
      }
    }

    return {
      status: "connected",
      message: models.length > 0
        ? `Connected successfully. ${models.length} model${models.length === 1 ? "" : "s"} available.`
        : "Connected successfully. The API key was accepted.",
      latencyMs: elapsedSince(startedAt),
      modelCount: models.length,
      ...(matched === true ? { modelMatched: true } : {}),
    }
  } catch (error: unknown) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    return {
      status: "error",
      message: timedOut
        ? `Connection timed out after ${Math.round(timeoutMs / 1000)} seconds. Check that the server is reachable from this deployment.`
        : "Could not reach the provider. Check the Base URL, DNS, TLS certificate, and network access from this deployment.",
      latencyMs: elapsedSince(startedAt),
    }
  }
}
