'use client'

import { useEffect } from 'react'
import { reportClientError } from '@/lib/clientLogs'

// Catches errors in the root layout itself. Must render its own <html>/<body>.
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    useEffect(() => {
        reportClientError({ message: error.message, stack: error.stack })
    }, [error])

    return (
        <html lang="en">
            <body style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
                <h2>Application error</h2>
                <p style={{ color: '#666' }}>{error.message}</p>
                <button onClick={() => reset()} style={{ marginTop: '1rem' }}>
                    Reload
                </button>
            </body>
        </html>
    )
}
