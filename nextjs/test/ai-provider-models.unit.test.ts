import { describe, expect, it } from "vitest"

import { declaredModels } from "@/lib/ai-providers"

/**
 * pi-ai refuses a model its own catalog does not list, even when the provider
 * serves it: "provider deepseek has no configured model deepseek-flash". The
 * row's default is what the session asks for, so it has to be declared.
 */
describe("declaredModels", () => {
  it("declares a catalog route's chosen model, which pi-ai would otherwise refuse", () => {
    expect(declaredModels([], "deepseek-flash")).toEqual([{ id: "deepseek-flash" }])
  })

  it("leaves a declared list alone when it already carries the default", () => {
    const models = [{ id: "gpt-4o", contextWindow: 128000 }]
    expect(declaredModels(models, "gpt-4o")).toBe(models)
  })

  it("keeps the other models when it appends the default", () => {
    expect(declaredModels([{ id: "a" }], "b")).toEqual([{ id: "a" }, { id: "b" }])
  })

  it("declares nothing without a default, so the route keeps its own catalog", () => {
    expect(declaredModels([], null)).toEqual([])
    expect(declaredModels([], "  ")).toEqual([])
  })
})
