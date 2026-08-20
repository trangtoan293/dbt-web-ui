"use client"

import React, { useState, useEffect } from "react"
import { usePathname } from "next/navigation"
import Sidebar from "./Sidebar"
import TopBar from "./TopBar"
import { TopBarProvider } from "./TopBarContext"
import { cn } from "@/lib/utils"

interface AppLayoutProps {
  children: React.ReactNode
}

export default function AppLayout({ children }: AppLayoutProps) {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(true)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    const check = () => setIsDesktop(window.innerWidth >= 1024)
    check()
    window.addEventListener("resize", check)
    return () => window.removeEventListener("resize", check)
  }, [])

  const contentMargin = isDesktop ? (collapsed ? "4rem" : "15rem") : 0
  const isProjectWorkspace = /^\/develop\/(?!new$)[^/]+$/.test(pathname)

  return (
    <TopBarProvider>
      <div className="overflow-hidden bg-gray-50" style={{ minHeight: "100dvh" }}>
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
          onMobileClose={() => setMobileOpen(false)}
          mobileOpen={mobileOpen}
        />

        <div
          className="flex min-h-0 flex-col transition-all duration-200"
          style={{ minHeight: "100dvh", height: "100dvh", marginLeft: contentMargin }}
        >
          <TopBar onMenuClick={() => setMobileOpen(!mobileOpen)} />
          <main
            className={cn(
              "min-h-0 flex-1",
              isProjectWorkspace
                ? "overflow-hidden"
                : "overflow-auto px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 lg:px-8"
            )}
          >
            {children}
          </main>
        </div>
      </div>
    </TopBarProvider>
  )
}
