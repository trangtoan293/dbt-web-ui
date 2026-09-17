"use client"

import React, { Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Compass, DownloadCloud, Server, Waves } from "lucide-react"
import PageHeader from "@/components-v2/layout/PageHeader"
import ConnectionsView from "@/components-v2/connections/ConnectionsView"
import SourcesView from "@/components-v2/sources/SourcesView"
import LakehouseView from "@/components-v2/lakehouse/LakehouseView"
import { Button } from "@/components-v2/ui/button"
import { cn } from "@/lib/utils"

const SECTIONS = [
  { id: "sources", label: "Data loads", icon: DownloadCloud, title: "Data loads", description: "Manage saved loads from databases, APIs and files into your warehouse or lakehouse." },
  { id: "lakehouse", label: "Lakehouse", icon: Waves, title: "Share lakehouse tables", description: "Publish a lake schema as Iceberg tables for other query engines. To inspect models and columns, open Explore." },
  { id: "connections", label: "Connections", icon: Server, title: "Manage access to your systems", description: "Save and test connection details used by ingestion and dbt projects. Creating a connection does not load data." },
] as const

function DataPage(): React.ReactElement {
  const searchParams = useSearchParams()
  const section = SECTIONS.find((item) => item.id === searchParams.get("tab")) ?? SECTIONS[0]

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader eyebrow="Data workspace" title="Data" description="Manage data movement, connections and lakehouse publishing." />
      <nav aria-label="Data sections" className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {SECTIONS.map((item) => (
          <Link key={item.id} href={item.id === "sources" ? "/data" : `/data?tab=${item.id}`} scroll={false} aria-current={section.id === item.id ? "page" : undefined}
            className={cn("flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0078D4]", section.id === item.id ? "border-[#0078D4] text-[#0078D4]" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900")}>
            <item.icon className="h-4 w-4" />{item.label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-xl font-semibold tracking-tight text-slate-950">{section.title}</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">{section.description}</p></div>
        {section.id === "lakehouse" && <Button variant="outline" asChild><Link href="/explore"><Compass className="mr-2 h-4 w-4" /> Open Explore</Link></Button>}
      </div>
      {section.id === "connections" && <ConnectionsView />}
      {section.id === "sources" && <SourcesView />}
      {section.id === "lakehouse" && <LakehouseView />}
    </div>
  )
}

export default function DataPageWithParams(): React.ReactElement {
  return <Suspense fallback={<p className="p-6 text-sm text-slate-500">Loading data workspace…</p>}><DataPage /></Suspense>
}
