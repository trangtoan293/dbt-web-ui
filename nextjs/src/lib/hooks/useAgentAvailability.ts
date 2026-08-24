import { useEffect, useState } from 'react'
import { getAgentUrl } from '@/lib/api/client'

export interface AgentHealth {
    status?: string
    profile?: string
    model?: string
    /** Whether the deployment has a shared fallback key. */
    model_configured?: boolean
    /** The harness's own web UI, when the deployment runs one. */
    web_url?: string | null
}

export interface AgentAvailability {
    /** null while still checking; false when no assistant service answers. */
    available: boolean | null
    health: AgentHealth | null
    /** Whether this user has a provider with a stored key, from Settings. */
    userKeySet: boolean | null
}

/**
 * Whether this deployment has an assistant, and whether it can answer.
 *
 * Lives outside the panel because the toolbar needs the same answer: an entry
 * point that always fails is worse than no entry point.
 */
export function useAgentAvailability(): AgentAvailability {
    const [available, setAvailable] = useState<boolean | null>(null)
    const [health, setHealth] = useState<AgentHealth | null>(null)
    const [userKeySet, setUserKeySet] = useState<boolean | null>(null)

    useEffect(() => {
        let cancelled = false

        fetch(`${getAgentUrl()}/health`)
            .then(async (response) => {
                if (cancelled) return
                setAvailable(response.ok)
                if (response.ok) setHealth(await response.json())
            })
            .catch(() => !cancelled && setAvailable(false))

        // The user's own providers, configured in Settings. They outrank the
        // deployment's fallback key.
        fetch('/api/ai-providers')
            .then(async (response) => {
                if (cancelled || !response.ok) return
                const body = await response.json()
                const providers: { credentialConfigured?: boolean }[] = body?.providers ?? []
                setUserKeySet(providers.some((provider) => provider.credentialConfigured))
            })
            .catch(() => !cancelled && setUserKeySet(false))

        return () => {
            cancelled = true
        }
    }, [])

    return { available, health, userKeySet }
}
