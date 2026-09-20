"use client"

import React, { Suspense } from "react"
import { useParams } from "next/navigation"
import LoadDetail from "@/components-v2/sources/LoadDetail"

export default function LoadDetailPage(): React.ReactElement {
  const params = useParams()
  return (
    <Suspense fallback={<p className="p-6 text-sm text-slate-500">Loading load…</p>}>
      <LoadDetail sourceId={params.sourceId as string} />
    </Suspense>
  )
}
