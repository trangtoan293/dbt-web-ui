"use client"

import React from "react"
import Link from "next/link"
import { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface SidebarItemProps {
  href: string
  icon: LucideIcon
  label: string
  isActive: boolean
  collapsed: boolean
}

export default function SidebarItem({ href, icon: Icon, label, isActive, collapsed }: SidebarItemProps) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
        isActive
          ? "bg-[#0078D4]/10 text-[#0078D4]"
          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
      )}
      title={collapsed ? label : undefined}
    >
      <Icon className={cn("h-5 w-5 shrink-0", collapsed ? "mx-auto" : "mr-3")} />
      {!collapsed && <span>{label}</span>}
    </Link>
  )
}
