'use client'

import { useEffect } from 'react'
import { reportClientError } from '@/lib/clientLogs'

export default function Error({
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
        <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
            <h2>Something went wrong</h2>
            <p style={{ color: '#666' }}>{error.message}</p>
            <button onClick={() => reset()} style={{ marginTop: '1rem' }}>
                Try again
            </button>
        </div>
    )
}
