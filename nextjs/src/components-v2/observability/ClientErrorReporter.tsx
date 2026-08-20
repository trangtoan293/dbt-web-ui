'use client'

import { useEffect } from 'react'
import { initClientErrorReporting } from '@/lib/clientLogs'

/** Installs window.onerror / unhandledrejection reporting once. Renders nothing. */
export function ClientErrorReporter(): null {
    useEffect(() => {
        initClientErrorReporting()
    }, [])
    return null
}
