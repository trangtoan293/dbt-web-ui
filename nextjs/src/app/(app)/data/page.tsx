"use client"

import React, { Suspense, useCallback, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { DownloadCloud, Server, Snowflake } from "lucide-react"
import PageHeader from "@/components-v2/layout/PageHeader"
import PageTabs, { type PageTab } from "@/components-v2/layout/PageTabs"
import ConnectionsView from "@/components-v2/connections/ConnectionsView"
import SourcesView from "@/components-v2/sources/SourcesView"
import LakehouseView from "@/components-v2/lakehouse/LakehouseView"

type DataTab = "connections" | "sources" | "lakehouse"

const TABS: readonly PageTab<DataTab>[] = [
  { id: "connections", label: "Connections", icon: Server },
  { id: "sources", label: "Sources", icon: DownloadCloud },
  { id: "lakehouse", label: "Lakehouse", icon: Snowflake },
]

function DataPage(): React.ReactElement {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get("tab")
  const [tab, setTab] = useState<DataTab>(
    TABS.some((t) => t.id === requested) ? (requested as DataTab) : "connections"
  )

  // An ingest source always points at a connection, so the two live in one
  // section; the tab stays in the URL to keep the old routes linkable.
  const selectTab = useCallback(
    (next: DataTab) => {
      setTab(next)
      router.replace(next === "connections" ? "/data" : `/data?tab=${next}`, { scroll: false })
    },
    [router]
  )

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <PageHeader
        eyebrow="Data"
        title="Data"
        description="Warehouse connections your projects run against, the ingest sources that load tables into them, and the lakehouse they land in."
        actions={<PageTabs tabs={TABS} value={tab} onChange={selectTab} label="Data sections" />}
      />
      {tab === "connections" && <ConnectionsView />}
      {tab === "sources" && <SourcesView />}
      {tab === "lakehouse" && <LakehouseView />}
    </div>
  )
}

export default function DataPageWithParams(): React.ReactElement {
  // useSearchParams needs a boundary or the build fails on prerender.
  return (
    <Suspense fallback={null}>
      <DataPage />
    </Suspense>
  )
}
