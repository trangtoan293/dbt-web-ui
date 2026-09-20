"use client"

import React from "react"
import { useParams } from "next/navigation"
import LoadWizard from "@/components-v2/sources/wizard/LoadWizard"

export default function EditLoadPage(): React.ReactElement {
  const params = useParams()
  return <LoadWizard sourceId={params.sourceId as string} />
}
