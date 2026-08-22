"use client"

import React from "react"
import { usePathname } from "next/navigation"
import { CalendarClock, ChevronLeft, ChevronRight, Code2, Compass, Database, Home, X } from "lucide-react"
import { cn } from "@/lib/utils"
import SidebarItem from "./SidebarItem"
import BrandMark from "@/components-v2/shared/BrandMark"
import { APP_NAVIGATION, isNavigationItemActive } from "./navigation"

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onMobileClose: () => void
  mobileOpen: boolean
  interactive: boolean
}

const navigationIcons = {
  "/": Home,
  "/develop": Code2,
  "/orchestrate": CalendarClock,
  "/explore": Compass,
  "/data": Database,
} as const

export default function Sidebar({ collapsed, onToggle, onMobileClose, mobileOpen, interactive }: SidebarProps) {
  const pathname = usePathname()

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-20 cursor-default bg-slate-950/35 backdrop-blur-[2px] lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        aria-label="Primary navigation"
        aria-hidden={!interactive}
        inert={interactive ? undefined : true}
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-[min(18rem,calc(100vw-3rem))] flex-col border-r border-slate-200/80 bg-white/95 shadow-xl shadow-slate-950/5 backdrop-blur transition-all duration-200 lg:shadow-none",
          collapsed ? "lg:w-16" : "lg:w-64",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-slate-100 px-4">
          <BrandMark className="lg:hidden" />
          {collapsed ? (
            <BrandMark compact className="mx-auto hidden lg:inline-flex" />
          ) : (
            <BrandMark className="hidden lg:inline-flex" />
          )}
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onMobileClose}
            className="grid h-9 w-9 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2.5 py-4">
          {!collapsed && <p className="mb-2 hidden px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 lg:block">Workspace</p>}
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400 lg:hidden">Workspace</p>
          {APP_NAVIGATION.map((item) => (
            <SidebarItem
              key={item.href}
              href={item.href}
              icon={navigationIcons[item.href]}
              label={item.name}
              isActive={isNavigationItemActive(pathname, item.href)}
              collapsed={collapsed}
            />
          ))}
        </nav>

        <div className="shrink-0 border-t border-gray-200 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2">
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className="hidden w-full items-center justify-center rounded-lg px-2 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] lg:flex"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4 mr-2" />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </aside>
    </>
  )
}
