"use client"

import React from "react"
import { useParams } from "next/navigation"
import DevelopLayout from "@/components-v2/develop/DevelopLayout"

export default function ProjectIDEPage() {
  const params = useParams()
  const projectId = params.projectId as string

  return <DevelopLayout projectId={projectId} />
}
