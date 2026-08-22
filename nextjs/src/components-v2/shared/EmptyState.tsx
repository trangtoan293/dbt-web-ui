import React from "react"
import { LucideIcon } from "lucide-react"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
}

export default function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-14 text-center sm:py-16">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 ring-1 ring-inset ring-slate-200/70">
        <Icon className="h-7 w-7 text-slate-400" />
      </div>
      <h2 className="mt-4 text-lg font-semibold tracking-tight text-gray-950">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm leading-6 text-gray-500">{description}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}
