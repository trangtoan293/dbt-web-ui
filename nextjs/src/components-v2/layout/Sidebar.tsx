"use client"

import React from "react"
import { usePathname } from "next/navigation"
import {
  Home, Code2, History, Compass, Database, Settings,
  ChevronLeft, ChevronRight, X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import SidebarItem from "./SidebarItem"
import BrandMark from "@/components-v2/shared/BrandMark"

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onMobileClose: () => void
  mobileOpen: boolean
}

const navigation = [
  { name: "Home", href: "/", icon: Home },
  { name: "Develop", href: "/develop", icon: Code2 },
  { name: "History", href: "/runs", icon: History },
  { name: "Explore", href: "/explore", icon: Compass },
  { name: "Connections", href: "/connections", icon: Database },
  { name: "Settings", href: "/settings", icon: Settings },
]

export default function Sidebar({ collapsed, onToggle, onMobileClose, mobileOpen }: SidebarProps) {
  const pathname = usePathname()
  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(href + "/"))

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-gray-600/50 z-20 lg:hidden" onClick={onMobileClose} />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col bg-white border-r border-gray-200 transition-all duration-200",
          collapsed ? "w-16" : "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        <div className="flex h-14 items-center justify-between px-4 border-b border-gray-200">
          {!collapsed && (
            <BrandMark />
          )}
          {collapsed && (
            <BrandMark compact className="mx-auto" />
          )}
          <button onClick={onMobileClose} className="lg:hidden text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-4">
          {navigation.map((item) => (
            <SidebarItem
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.name}
              isActive={isActive(item.href)}
              collapsed={collapsed}
            />
          ))}
        </nav>

        <div className="shrink-0 border-t border-gray-200 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2">
          <button
            onClick={onToggle}
            className="flex w-full items-center justify-center rounded-md px-2 py-2 text-sm text-gray-500 hover:bg-gray-100"
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
