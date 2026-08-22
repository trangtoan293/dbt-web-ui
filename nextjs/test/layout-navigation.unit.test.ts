import {
  getPageLabel,
  isNavigationItemActive,
  parseSidebarCollapsedPreference,
} from "@/components-v2/layout/navigation"

describe("layout navigation", () => {
  it("matches the root route without matching every page", () => {
    expect(isNavigationItemActive("/", "/")).toBe(true)
    expect(isNavigationItemActive("/develop", "/")).toBe(false)
  })

  it("keeps a navigation section active on nested routes", () => {
    expect(isNavigationItemActive("/develop/project-1", "/develop")).toBe(true)
    expect(isNavigationItemActive("/developing", "/develop")).toBe(false)
  })

  it("returns a useful page label for root, nested, and unknown routes", () => {
    expect(getPageLabel("/")).toBe("Home")
    expect(getPageLabel("/develop/project-1")).toBe("Develop")
    expect(getPageLabel("/unknown")).toBe("Workspace")
  })

  it("labels Settings even though it has no sidebar slot", async () => {
    // Settings is reached from the avatar menu; without a secondary entry the
    // top bar would fall back to "Workspace" on /settings.
    const { APP_NAVIGATION } = await import("@/components-v2/layout/navigation")
    expect(APP_NAVIGATION.some((item) => item.href === "/settings")).toBe(false)
    expect(getPageLabel("/settings")).toBe("Settings")
  })

  it("keeps the sidebar to the five workspace sections", async () => {
    const { APP_NAVIGATION } = await import("@/components-v2/layout/navigation")
    expect(APP_NAVIGATION.map((item) => item.href)).toEqual([
      "/",
      "/develop",
      "/orchestrate",
      "/explore",
      "/data",
    ])
  })

  it("defaults the sidebar to expanded and only accepts an explicit collapsed preference", () => {
    expect(parseSidebarCollapsedPreference(null)).toBe(false)
    expect(parseSidebarCollapsedPreference("false")).toBe(false)
    expect(parseSidebarCollapsedPreference("true")).toBe(true)
  })
})

describe("layout navigation icons", () => {
  it("gives every navigation entry an icon", async () => {
    // A missing icon renders an empty sidebar slot rather than failing a build.
    const { APP_NAVIGATION } = await import("@/components-v2/layout/navigation")
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/components-v2/layout/Sidebar.tsx", "utf8"),
    )
    for (const item of APP_NAVIGATION) {
      expect(source).toContain(`"${item.href}":`)
    }
  })
})
