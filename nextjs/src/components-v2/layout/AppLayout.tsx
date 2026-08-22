"use client"

import React, { useEffect, useState } from "react"
import { usePathname } from "next/navigation"
import Sidebar from "./Sidebar"
import TopBar from "./TopBar"
import { TopBarProvider } from "./TopBarContext"
import { cn } from "@/lib/utils"
import { parseSidebarCollapsedPreference } from "./navigation"

interface AppLayoutProps {
  children: React.ReactNode
}

export default function AppLayout({ children }: AppLayoutProps) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [desktopNavigationVisible, setDesktopNavigationVisible] = useState(false)

  useEffect(() => {
    setCollapsed(parseSidebarCollapsedPreference(window.localStorage.getItem("dbt-craft:sidebar-collapsed")))
  }, [])

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)")
    const update = () => setDesktopNavigationVisible(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  useEffect(() => {
    if (!mobileOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [mobileOpen])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const handleToggle = () => {
    setCollapsed((current) => {
      const next = !current
      window.localStorage.setItem("dbt-craft:sidebar-collapsed", String(next))
      return next
    })
  }

  const isProjectWorkspace = /^\/develop\/(?!new$)[^/]+$/.test(pathname)

  return (
    <TopBarProvider>
      <div className="app-shell overflow-hidden bg-slate-50" style={{ minHeight: "100dvh" }}>
        <Sidebar
          collapsed={collapsed}
          onToggle={handleToggle}
          onMobileClose={() => setMobileOpen(false)}
          mobileOpen={mobileOpen}
          interactive={desktopNavigationVisible || mobileOpen}
        />

        <div
          className={cn(
            "flex min-h-0 flex-col transition-[margin] duration-200 ease-out lg:ml-64",
            collapsed && "lg:ml-16"
          )}
          style={{ minHeight: "100dvh", height: "100dvh" }}
        >
          <TopBar onMenuClick={() => setMobileOpen(!mobileOpen)} />
          <main
            className={cn(
              "min-h-0 flex-1",
              isProjectWorkspace
                ? "overflow-hidden"
                : "overflow-auto px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:px-8 lg:pt-7"
            )}
          >
            {children}
          </main>
        </div>
      </div>
    </TopBarProvider>
  )
}
