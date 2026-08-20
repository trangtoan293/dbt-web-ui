"use client"

import React from "react"
import { GlobalProvider } from "@/lib/context/GlobalContext"
import AppLayout from "@/components-v2/layout/AppLayout"

export default function V2AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <GlobalProvider>
      <AppLayout>{children}</AppLayout>
    </GlobalProvider>
  )
}
