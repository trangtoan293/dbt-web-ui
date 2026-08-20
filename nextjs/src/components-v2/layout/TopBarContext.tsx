"use client"

import React, { createContext, useContext, useState } from "react"

interface TopBarContextValue {
  content: React.ReactNode
  setContent: React.Dispatch<React.SetStateAction<React.ReactNode>>
}

const TopBarContext = createContext<TopBarContextValue | undefined>(undefined)

export function TopBarProvider({ children }: { children: React.ReactNode }) {
  const [content, setContent] = useState<React.ReactNode>(null)

  return (
    <TopBarContext.Provider value={{ content, setContent }}>
      {children}
    </TopBarContext.Provider>
  )
}

export function useTopBar() {
  const context = useContext(TopBarContext)
  if (!context) {
    throw new Error("useTopBar must be used within a TopBarProvider")
  }
  return context
}
