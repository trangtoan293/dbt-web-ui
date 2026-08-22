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
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group flex min-h-10 items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] focus-visible:ring-offset-1",
        isActive
          ? "bg-[#0078D4]/10 text-[#006CBE] shadow-[inset_0_0_0_1px_rgba(0,120,212,0.08)]"
          : "text-gray-600 hover:bg-slate-100 hover:text-gray-950"
      )}
      title={collapsed ? label : undefined}
    >
      <Icon className={cn("mr-3 h-5 w-5 shrink-0", collapsed && "lg:mx-auto lg:mr-0")} />
      <span className={cn(collapsed && "lg:hidden")}>{label}</span>
    </Link>
  )
}
