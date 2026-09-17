import { describe, expect, it } from "vitest"

import {
  createProviderDraft,
  draftToProviderInput,
  validateProviderDraft,
} from "@/lib/ai-provider-form"

describe("AI provider settings form", () => {
  it("starts a built-in provider with implementation details derived automatically", () => {
    const draft = createProviderDraft("openai")
    draft.apiKey = "sk-test"

    expect(draftToProviderInput(draft)).toMatchObject({
      route: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
      api: null,
      baseUrl: null,
      models: [],
      apiKey: "sk-test",
    })
    expect(validateProviderDraft(draft)).toBeNull()
  })

  it("maps a custom OpenAI-compatible setup to the harness provider shape", () => {
    const draft = createProviderDraft("custom")
    Object.assign(draft, {
      route: "company-ai",
      label: "Company AI Gateway",
      apiKey: "gateway-key",
      api: "openai-completions",
      baseUrl: "https://ai.company.example/v1/",
      models: "company-large, company-fast\ncompany-large",
      defaultModel: "company-fast",
    })

    expect(draftToProviderInput(draft)).toEqual({
      route: "company-ai",
      label: "Company AI Gateway",
      apiKeyEnv: "COMPANY_AI_API_KEY",
      api: "openai-completions",
      baseUrl: "https://ai.company.example/v1/",
      models: [{ id: "company-large" }, { id: "company-fast" }],
      defaultModel: "company-fast",
      isDefault: false,
      apiKey: "gateway-key",
    })
  })

  it("names each missing custom field instead of returning harness terminology", () => {
    const draft = createProviderDraft("custom")

    expect(validateProviderDraft(draft)).toBe("Enter a connection name")
    draft.route = "company-ai"
    expect(validateProviderDraft(draft)).toBe("Enter the API Base URL")
    draft.baseUrl = "https://ai.company.example/v1"
    expect(validateProviderDraft(draft)).toBe("Enter at least one model ID")
  })

  it("allows an existing saved credential to be checked without entering it again", () => {
    const draft = createProviderDraft("openai")
    draft.credentialConfigured = true

    expect(validateProviderDraft(draft)).toBeNull()
    expect(draftToProviderInput(draft).apiKey).toBeNull()
  })
})
