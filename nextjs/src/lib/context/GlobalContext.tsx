'use client'

import React, { createContext, useContext, useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'

type User = {
  email: string
  id: string
  name?: string
  // Populated from the DB user's created_at when available; the session does
  // not carry it yet, so consumers must treat it as optional.
  registered_at?: Date
}

interface GlobalContextType {
  loading: boolean
  user: User | null
}

const GlobalContext = createContext<GlobalContextType | undefined>(undefined)

export function GlobalProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    if (status === 'authenticated' && session?.user) {
      setUser({
        email: session.user.email!,
        id: session.user.id!,
        name: session.user.name ?? undefined,
      })
    } else if (status === 'unauthenticated') {
      setUser(null)
    }
  }, [session, status])

  return (
    <GlobalContext.Provider value={{ loading: status === 'loading', user }}>
      {children}
    </GlobalContext.Provider>
  )
}

export const useGlobal = () => {
  const context = useContext(GlobalContext)
  if (context === undefined) {
    throw new Error('useGlobal must be used within a GlobalProvider')
  }
  return context
}
