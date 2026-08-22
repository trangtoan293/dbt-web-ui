"use client"

import React, { Suspense, useCallback, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CalendarClock, History } from "lucide-react"
import PageHeader from "@/components-v2/layout/PageHeader"
import PageTabs, { type PageTab } from "@/components-v2/layout/PageTabs"
import RunsView from "@/components-v2/runs/RunsView"
import SchedulesView from "@/components-v2/schedules/SchedulesView"
import { cn } from "@/lib/utils"

type OrchestrateTab = "runs" | "schedules"

const TABS: readonly PageTab<OrchestrateTab>[] = [
  { id: "runs", label: "Runs", icon: History },
  { id: "schedules", label: "Schedules", icon: CalendarClock },
]

// Runs needs the width for its log table; schedules is a short list.
const TAB_WIDTH: Record<OrchestrateTab, string> = {
  runs: "max-w-[1600px]",
  schedules: "max-w-4xl",
}

function OrchestratePage(): React.ReactElement {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<OrchestrateTab>(
    searchParams.get("tab") === "schedules" ? "schedules" : "runs"
  )

  // Keep the tab in the URL so /schedules can redirect straight into it and
  // so a bookmark still lands where it used to.
  const selectTab = useCallback(
    (next: OrchestrateTab) => {
      setTab(next)
      router.replace(next === "runs" ? "/orchestrate" : `/orchestrate?tab=${next}`, { scroll: false })
    },
    [router]
  )

  return (
    <div className={cn("mx-auto w-full space-y-5", TAB_WIDTH[tab])}>
      <PageHeader
        eyebrow="Orchestration"
        title="Orchestrate"
        description="Schedule dbt commands on a cron and review every invocation they produce."
        actions={<PageTabs tabs={TABS} value={tab} onChange={selectTab} label="Orchestrate sections" />}
      />
      {tab === "runs" ? <RunsView /> : <SchedulesView />}
    </div>
  )
}

export default function OrchestratePageWithParams(): React.ReactElement {
  // useSearchParams needs a boundary or the build fails on prerender.
  return (
    <Suspense fallback={null}>
      <OrchestratePage />
    </Suspense>
  )
}
