"use client"

import React, { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CalendarClock, History } from "lucide-react"
import PageTabs, { type PageTab } from "@/components-v2/layout/PageTabs"
import RunsView from "@/components-v2/runs/RunsView"
import SchedulesView from "@/components-v2/schedules/SchedulesView"

type OrchestrateTab = "runs" | "schedules"

const TABS: readonly PageTab<OrchestrateTab>[] = [
  { id: "runs", label: "Runs", icon: History },
  { id: "schedules", label: "Schedules", icon: CalendarClock },
]

function OrchestratePage(): React.ReactElement {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tab: OrchestrateTab = searchParams.get("tab") === "schedules" ? "schedules" : "runs"

  // Keep the tab in the URL so /schedules can redirect straight into it and
  // so a bookmark still lands where it used to.
  const selectTab = useCallback(
    (next: OrchestrateTab) => {
      router.replace(next === "runs" ? "/orchestrate" : `/orchestrate?tab=${next}`, { scroll: false })
    },
    [router]
  )

  return (
    <div className="w-full min-w-0">
      <h1 className="sr-only">Orchestrate</h1>
      {tab === "runs" ? <RunsView navigation={<PageTabs tabs={TABS} value={tab} onChange={selectTab} label="Orchestrate sections" />} /> : <SchedulesView navigation={<PageTabs tabs={TABS} value={tab} onChange={selectTab} label="Orchestrate sections" />} />}
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
