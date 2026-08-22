import { describe, expect, it } from "vitest"

import nextConfig from "../next.config"
import { APP_NAVIGATION } from "@/components-v2/layout/navigation"

// Runs+Schedules became /orchestrate and Connections+Sources became /data.
// Dropping a redirect breaks every bookmark and every link in an old run
// notification, and does it silently — the old path just 404s.
const RETIRED_ROUTES: Record<string, string> = {
  "/runs": "/orchestrate",
  "/schedules": "/orchestrate?tab=schedules",
  "/connections": "/data",
  "/sources": "/data?tab=sources",
}

describe("retired route redirects", () => {
  it("keeps every merged route reachable", async () => {
    const redirects = await nextConfig.redirects!()
    const bySource = Object.fromEntries(redirects.map((rule) => [rule.source, rule.destination]))

    expect(bySource).toMatchObject(RETIRED_ROUTES)
  })

  it("never redirects to a path that is not itself in the sidebar", async () => {
    const redirects = await nextConfig.redirects!()
    const sidebarHrefs = new Set(APP_NAVIGATION.map((item) => item.href))

    for (const rule of redirects) {
      const path = String(rule.destination).split("?")[0]
      expect(sidebarHrefs.has(path)).toBe(true)
    }
  })

  it("does not redirect a route the sidebar still points at", async () => {
    const redirects = await nextConfig.redirects!()
    const sources = new Set(redirects.map((rule) => rule.source))

    for (const item of APP_NAVIGATION) {
      expect(sources.has(item.href)).toBe(false)
    }
  })
})
