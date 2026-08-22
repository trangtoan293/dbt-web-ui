"use client"

import React from "react"
import { usePathname, useRouter } from "next/navigation"
import { Menu, ChevronDown, Key, LogOut, HelpCircle } from "lucide-react"
import { useGlobal } from "@/lib/context/GlobalContext"
import { useTopBar } from "./TopBarContext"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components-v2/ui/dropdown-menu"
import { getPageLabel } from "./navigation"

interface TopBarProps {
  onMenuClick: () => void
}

function getInitials(email: string): string {
  const parts = email.split("@")[0].split(/[._-]/)
  return parts.length > 1
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : parts[0].slice(0, 2).toUpperCase()
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const { user } = useGlobal()
  const { content } = useTopBar()
  const router = useRouter()
  const pathname = usePathname()

  const handleLogout = () => {
    window.location.href = "/logout"
  }

  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-slate-200/80 bg-white/85 px-3 backdrop-blur-xl sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={onMenuClick}
          className="grid h-9 w-9 place-items-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        {content || <span className="truncate text-sm font-semibold text-gray-800">{getPageLabel(pathname)}</span>}
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2">
        <a
          href="https://github.com/trangtoan293/dbt-web-ui#readme"
          target="_blank"
          rel="noreferrer"
          aria-label="Open documentation"
          className="grid h-9 w-9 place-items-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]"
          title="Documentation"
        >
          <HelpCircle className="h-5 w-5" />
        </a>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex h-10 items-center gap-2 rounded-full px-1.5 pr-2 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-50 to-cyan-50 ring-1 ring-blue-100">
              <span className="text-sm font-medium text-[#0078D4]">
                {user ? getInitials(user.email) : "??"}
              </span>
            </div>
            <span className="hidden sm:inline text-sm text-gray-700">{user?.email || ""}</span>
            <ChevronDown className="h-4 w-4 text-gray-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <p className="text-xs text-gray-500">Signed in as</p>
              <p className="text-sm font-medium text-gray-900 truncate">{user?.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/settings")}>
              <Key className="mr-2 h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} className="text-red-600 focus:text-red-600">
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
