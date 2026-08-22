"use client"

import React, { Suspense, useCallback, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { DownloadCloud, Server } from "lucide-react"
import PageHeader from "@/components-v2/layout/PageHeader"
import PageTabs, { type PageTab } from "@/components-v2/layout/PageTabs"
import ConnectionsView from "@/components-v2/connections/ConnectionsView"
import SourcesView from "@/components-v2/sources/SourcesView"

type DataTab = "connections" | "sources"

const TABS: readonly PageTab<DataTab>[] = [
  { id: "connections", label: "Connections", icon: Server },
  { id: "sources", label: "Sources", icon: DownloadCloud },
]

function DataPage(): React.ReactElement {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<DataTab>(
    searchParams.get("tab") === "sources" ? "sources" : "connections"
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
        description="Warehouse connections your projects run against, and the ingest sources that load tables into them."
        actions={<PageTabs tabs={TABS} value={tab} onChange={selectTab} label="Data sections" />}
      />
      {tab === "connections" ? <ConnectionsView /> : <SourcesView />}
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
