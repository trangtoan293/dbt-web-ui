"use client"

import React from "react"
import { useRouter } from "next/navigation"
import { Menu, ChevronDown, Key, LogOut, HelpCircle } from "lucide-react"
import { useGlobal } from "@/lib/context/GlobalContext"
import { useTopBar } from "./TopBarContext"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components-v2/ui/dropdown-menu"

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

  const handleLogout = () => {
    window.location.href = "/logout"
  }

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4">
      <div className="flex min-w-0 items-center gap-3">
        <button onClick={onMenuClick} className="lg:hidden text-gray-500 hover:text-gray-700">
          <Menu className="h-5 w-5" />
        </button>
        {content}
      </div>

      <div className="flex items-center gap-3">
        <button className="text-gray-400 hover:text-gray-600" title="Documentation">
          <HelpCircle className="h-5 w-5" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-full hover:bg-gray-100 px-2 py-1 transition-colors">
            <div className="h-8 w-8 rounded-full bg-[#0078D4]/10 flex items-center justify-center">
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
