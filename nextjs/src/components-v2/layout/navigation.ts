export const APP_NAVIGATION = [
  { name: "Home", href: "/" },
  { name: "Develop", href: "/develop" },
  { name: "Orchestrate", href: "/orchestrate" },
  { name: "Explore", href: "/explore" },
  { name: "Data", href: "/data" },
] as const

// Pages that have a title but no sidebar slot. Settings is reached from the
// avatar menu: it is account/deployment scope, not something you steer the
// workspace with, and a second entry point made it appear twice.
const SECONDARY_PAGES = [{ name: "Settings", href: "/settings" }] as const

export function isNavigationItemActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`))
}

export function getPageLabel(pathname: string): string {
  const item =
    APP_NAVIGATION.find((entry) => isNavigationItemActive(pathname, entry.href)) ??
    SECONDARY_PAGES.find((entry) => isNavigationItemActive(pathname, entry.href))
  return item?.name ?? "Workspace"
}

export function parseSidebarCollapsedPreference(value: string | null): boolean {
  return value === "true"
}
