import { useCallback, useEffect, useRef, useState } from 'react'
import { getSession } from 'next-auth/react'
import { getAgentUrl } from '@/lib/api/client'

/** One normalized event from dsh-agent. The harness vocabulary stays server-side. */
export interface AgentEvent {
    type: 'session' | 'status' | 'delta' | 'reasoning' | 'text' | 'tool_start' | 'tool_end'
        | 'todo' | 'usage' | 'turn_end' | 'error' | 'done' | 'prompt'
    session_id?: string
    status?: string
    text?: string
    tool?: string
    id?: string
    input?: unknown
    ok?: boolean
    items?: unknown
    reason?: string
    error?: string
    input_tokens?: number
    output_tokens?: number
    cached_tokens?: number
    reasoning_tokens?: number
}

export interface AgentToolCall {
    name: string
    callId?: string
    input?: string
    /** undefined while it is still running. */
    ok?: boolean
}

export interface AgentMessage {
    role: 'user' | 'assistant' | 'reasoning' | 'tool' | 'error'
    text: string
    tool?: AgentToolCall
    /** Still being streamed: provisional text the commit may replace. */
    streaming?: boolean
}

export interface AgentTodo {
    content?: string
    status?: string
}

export interface AgentUsage {
    input_tokens?: number
    output_tokens?: number
    cached_tokens?: number
    reasoning_tokens?: number
}

export interface AgentSessionSummary {
    session_id: string
    title: string
    updated_at: number
    turns: number
}

async function authHeaders(): Promise<Record<string, string>> {
    const session = await getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`
    return headers
}

/** Turn one event into the message list change it implies. */
function reduce(messages: AgentMessage[], event: AgentEvent): AgentMessage[] {
    const last = messages[messages.length - 1]

    switch (event.type) {
        case 'prompt':
            return [...messages, { role: 'user', text: event.text ?? '' }]
        case 'reasoning':
        case 'delta': {
            const role = event.type === 'delta' ? 'assistant' : 'reasoning'
            if (last?.streaming && last.role === role) {
                return [...messages.slice(0, -1), { ...last, text: last.text + (event.text ?? '') }]
            }
            return [...messages, { role, text: event.text ?? '', streaming: true }]
        }
        case 'text':
            // The committed message is authoritative: streamed tokens are
            // provisional and a retry can replace them, so settle the open
            // message on this text rather than appending it again.
            if (last?.streaming && last.role === 'assistant') {
                return [...messages.slice(0, -1), { role: 'assistant', text: event.text ?? '' }]
            }
            return [...messages, { role: 'assistant', text: event.text ?? '' }]
        case 'tool_start':
            return [...messages, {
                role: 'tool',
                text: event.tool ?? 'tool',
                tool: {
                    name: event.tool ?? 'tool',
                    callId: event.id,
                    input: typeof event.input === 'string' ? event.input : JSON.stringify(event.input),
                },
            }]
        case 'tool_end':
            // The result carries no tool name, only the call id.
            return messages.map((message) =>
                message.tool?.callId && message.tool.callId === event.id
                    ? { ...message, tool: { ...message.tool, ok: event.ok } }
                    : message
            )
        case 'turn_end':
            if (event.reason && event.reason !== 'completed') {
                return [...messages, { role: 'error', text: event.error ?? `turn ended: ${event.reason}` }]
            }
            return messages
        case 'error':
            return [...messages, { role: 'error', text: event.error ?? 'agent failed' }]
        default:
            return messages
    }
}

/**
 * One conversation with dsh-agent: live streaming plus the history behind it.
 *
 * History comes from the harness's own session log, replayed through the same
 * event shapes the live stream uses, so a reopened conversation looks like the
 * one that was left.
 */
export function useAgentStream(projectId: string) {
    const [messages, setMessages] = useState<AgentMessage[]>([])
    const [isStreaming, setIsStreaming] = useState(false)
    const [sessionId, setSessionId] = useState<string | null>(null)
    const [sessions, setSessions] = useState<AgentSessionSummary[]>([])
    const [todos, setTodos] = useState<AgentTodo[]>([])
    const [usage, setUsage] = useState<AgentUsage | null>(null)
    const [loadingHistory, setLoadingHistory] = useState(false)
    const controllerRef = useRef<AbortController | null>(null)

    const apply = useCallback((event: AgentEvent) => {
        if (event.type === 'session' && event.session_id) {
            setSessionId(event.session_id)
            return
        }
        if (event.type === 'todo') {
            setTodos(Array.isArray(event.items) ? (event.items as AgentTodo[]) : [])
            return
        }
        if (event.type === 'usage') {
            setUsage({
                input_tokens: event.input_tokens,
                output_tokens: event.output_tokens,
                cached_tokens: event.cached_tokens,
                reasoning_tokens: event.reasoning_tokens,
            })
            return
        }
        setMessages((current) => reduce(current, event))
    }, [])

    const refreshSessions = useCallback(async () => {
        try {
            const response = await fetch(`${getAgentUrl()}/agent/${projectId}/sessions`, {
                headers: await authHeaders(),
            })
            if (!response.ok) return
            const body = await response.json()
            setSessions(Array.isArray(body?.sessions) ? body.sessions : [])
        } catch {
            // A listing that cannot be read is not worth interrupting a chat for.
        }
    }, [projectId])

    useEffect(() => {
        void refreshSessions()
    }, [refreshSessions])

    const openSession = useCallback(async (id: string) => {
        controllerRef.current?.abort()
        setSessionId(id)
        setMessages([])
        setTodos([])
        setUsage(null)
        setLoadingHistory(true)
        try {
            const response = await fetch(
                `${getAgentUrl()}/agent/${projectId}/sessions/${id}`,
                { headers: await authHeaders() },
            )
            if (!response.ok) return
            const body = await response.json()
            const events: AgentEvent[] = Array.isArray(body?.events) ? body.events : []
            setMessages(events.reduce(reduce, [] as AgentMessage[]))
        } finally {
            setLoadingHistory(false)
        }
    }, [projectId])

    const startNewSession = useCallback(() => {
        controllerRef.current?.abort()
        setSessionId(null)
        setMessages([])
        setTodos([])
        setUsage(null)
    }, [])

    const send = useCallback(async (text: string, attachment?: string) => {
        if (!text.trim() || isStreaming) return
        const prompt = attachment
            ? `The file currently open in the editor is ${attachment}.\n\n${text}`
            : text
        apply({ type: 'prompt', text })
        setIsStreaming(true)

        const controller = new AbortController()
        controllerRef.current = controller

        try {
            const response = await fetch(`${getAgentUrl()}/agent/${projectId}/prompt`, {
                method: 'POST',
                headers: await authHeaders(),
                body: JSON.stringify({ text: prompt, session_id: sessionId }),
                signal: controller.signal,
            })

            if (!response.ok || !response.body) {
                apply({
                    type: 'error',
                    error: response.status === 429
                        ? 'Every agent session is busy. Try again shortly.'
                        : `agent returned ${response.status}`,
                })
                return
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''

            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })

                const frames = buffer.split('\n\n')
                buffer = frames.pop() ?? ''
                for (const frame of frames) {
                    const line = frame.split('\n').find((part) => part.startsWith('data: '))
                    if (!line) continue
                    try {
                        apply(JSON.parse(line.slice(6)) as AgentEvent)
                    } catch {
                        continue
                    }
                }
            }
        } catch (error) {
            if ((error as Error).name !== 'AbortError') {
                apply({ type: 'error', error: (error as Error).message })
            }
        } finally {
            setIsStreaming(false)
            controllerRef.current = null
            // Nothing is in flight any more; a message left open would keep
            // absorbing the next turn's tokens.
            setMessages((current) => current.map((message) =>
                message.streaming ? { ...message, streaming: false } : message
            ))
            void refreshSessions()
        }
    }, [apply, isStreaming, projectId, refreshSessions, sessionId])

    const stop = useCallback(async () => {
        // Abort the read first so the UI settles even if the service is slow,
        // then ask it to kill the session process - the wire has no cancel.
        controllerRef.current?.abort()
        if (!sessionId) return
        await fetch(`${getAgentUrl()}/agent/${projectId}/stop`, {
            method: 'POST',
            headers: await authHeaders(),
            body: JSON.stringify({ session_id: sessionId }),
        }).catch(() => undefined)
    }, [projectId, sessionId])

    return {
        messages, isStreaming, sessionId, sessions, todos, usage, loadingHistory,
        send, stop, openSession, startNewSession, refreshSessions,
    }
}
