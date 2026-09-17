import { describe, expect, it, vi } from "vitest"

import { checkProviderConnection } from "@/lib/ai-provider-connection"

describe("AI provider connection checks", () => {
  it("checks an OpenAI-compatible models endpoint with bearer authentication", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
    }), { status: 200, headers: { "content-type": "application/json" } }))

    const result = await checkProviderConnection({
      route: "openai",
      apiKey: "sk-secret",
      defaultModel: "gpt-5",
    }, fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer sk-secret" }),
        redirect: "error",
      }),
    )
    expect(result).toMatchObject({
      status: "connected",
      modelCount: 2,
      modelMatched: true,
    })
  })

  it("keeps the /v1 path for a custom OpenAI-compatible endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "acme-large" }],
    }), { status: 200, headers: { "content-type": "application/json" } }))

    await checkProviderConnection({
      route: "acme",
      apiKey: "gateway-secret",
      baseUrl: "https://gateway.example/v1/",
      defaultModel: "acme-large",
    }, fetcher)

    expect(fetcher).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gateway-secret" }),
      }),
    )
  })

  it("uses the provider-specific authentication header for Anthropic", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))

    await checkProviderConnection({ route: "anthropic", apiKey: "anthropic-secret" }, fetcher)

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "anthropic-secret",
          "anthropic-version": "2023-06-01",
        }),
      }),
    )
  })

  it("returns an actionable authentication error without exposing the key", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Invalid bearer token sk-secret" },
    }), { status: 401, headers: { "content-type": "application/json" } }))

    const result = await checkProviderConnection({
      route: "openai",
      apiKey: "sk-secret",
    }, fetcher)

    expect(result.status).toBe("error")
    expect(result.message).toMatch(/API key/i)
    expect(result.message).not.toContain("sk-secret")
  })

  it("explains the common missing-/v1 error for a custom endpoint", async () => {
    const fetcher = vi.fn(async () => new Response("Not found", { status: 404 }))

    const result = await checkProviderConnection({
      route: "acme",
      apiKey: "secret",
      baseUrl: "https://gateway.example",
    }, fetcher)

    expect(result).toMatchObject({ status: "error" })
    expect(result.message).toMatch(/end in \/v1/i)
  })

  it("warns when credentials work but the configured model is not listed", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "another-model" }],
    }), { status: 200, headers: { "content-type": "application/json" } }))

    const result = await checkProviderConnection({
      route: "acme",
      apiKey: "secret",
      baseUrl: "https://gateway.example/v1",
      defaultModel: "acme-large",
    }, fetcher)

    expect(result).toMatchObject({ status: "warning", modelMatched: false })
    expect(result.message).toContain("acme-large")
  })
})
