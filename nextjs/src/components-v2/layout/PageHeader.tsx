import React from "react"
import { cn } from "@/lib/utils"

interface PageHeaderProps {
  title: string
  description: string
  eyebrow?: string
  actions?: React.ReactNode
  className?: string
}

export default function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps): React.ReactElement {
  return (
    <header className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[#0078D4]">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-gray-950 sm:text-[1.75rem]">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}
