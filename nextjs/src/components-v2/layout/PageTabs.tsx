"use client"

import React from "react"
import { cn } from "@/lib/utils"

export interface PageTab<T extends string> {
  id: T
  label: string
  icon: React.ElementType
}

interface PageTabsProps<T extends string> {
  tabs: readonly PageTab<T>[]
  value: T
  onChange: (id: T) => void
  /** Accessible name, e.g. "Orchestrate sections". */
  label: string
}

/**
 * Segmented control for a page that hosts two or more sibling views.
 * Sits in PageHeader's actions slot so the section keeps one title.
 */
export default function PageTabs<T extends string>({ tabs, value, onChange, label }: PageTabsProps<T>) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
      {tabs.map((tab) => {
        const isActive = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]",
              isActive ? "bg-[#0078D4] text-white" : "text-gray-600 hover:bg-gray-100"
            )}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
