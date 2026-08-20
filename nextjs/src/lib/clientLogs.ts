/**
 * Browser error reporting → dbt-runner /client-logs → OpenObserve.
 * Fire-and-forget; never throws (a failing reporter must not mask the original error).
 */

import { getDbtRunnerUrl } from '@/lib/api/client'

interface ClientErrorReport {
    message: string
    stack?: string
    url?: string
    level?: 'error' | 'warn'
}

export function reportClientError(report: ClientErrorReport): void {
    try {
        const body = JSON.stringify({
            message: String(report.message).slice(0, 2000),
            stack: report.stack?.slice(0, 8000),
            url: report.url ?? (typeof window !== 'undefined' ? window.location.href : undefined),
            level: report.level ?? 'error',
        })
        // keepalive lets the POST survive a page unload during a hard crash.
        void fetch(`${getDbtRunnerUrl()}/client-logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => {})
    } catch {
        // swallow — reporting must never break the app
    }
}

let installed = false

/** Install global handlers once (call from a client provider mounted in layout). */
export function initClientErrorReporting(): void {
    if (installed || typeof window === 'undefined') return
    installed = true

    window.addEventListener('error', (e: ErrorEvent) => {
        reportClientError({ message: e.message, stack: e.error?.stack, url: e.filename })
    })
    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        const reason = e.reason
        reportClientError({
            message: reason?.message ?? String(reason),
            stack: reason?.stack,
        })
    })
}
