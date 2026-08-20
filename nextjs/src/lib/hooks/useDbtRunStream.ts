import { useEffect, useRef, useCallback, useState } from 'react';
import { getSession } from 'next-auth/react';
import { getDbtRunnerUrl } from '@/lib/api/client';

interface DbtRunEvent {
    type: 'started' | 'output' | 'completed' | 'error';
    command?: string;
    line?: string;
    returncode?: number;
    error?: string;
}

interface UseDbtRunStreamOptions {
    projectId: string;
    onLogLine?: (line: string) => void;
    onCommandStart?: (command: string) => void;
    onCommandComplete?: (returncode: number) => void;
    onError?: (error: string) => void;
    autoConnect?: boolean;
}

interface StreamListener {
    onMessage: (message: DbtRunEvent) => void;
    onStatusChange: (isConnected: boolean, isConnecting: boolean) => void;
}

interface ActiveStream {
    controller: AbortController;
    listeners: Set<StreamListener>;
    backgroundMessages: DbtRunEvent[];
    isConnected: boolean;
    isConnecting: boolean;
}

const activeStreams = new Map<string, ActiveStream>();

const emitStatus = (stream: ActiveStream) => {
    stream.listeners.forEach((listener) => {
        listener.onStatusChange(stream.isConnected, stream.isConnecting);
    });
};

const emitMessage = (stream: ActiveStream, message: DbtRunEvent) => {
    if (stream.listeners.size === 0) {
        stream.backgroundMessages.push(message);
        if (stream.backgroundMessages.length > 5000) {
            stream.backgroundMessages.shift();
        }
        return;
    }

    stream.listeners.forEach((listener) => listener.onMessage(message));
};

/**
 * Hook for streaming dbt command output via SSE (POST + ReadableStream).
 * connect() is a no-op that always resolves true — SSE connects per-command.
 * Streams live outside the component so route navigation does not cancel an
 * active dbt process. Messages received while the IDE is unmounted are replayed
 * when it mounts again.
 */
export function useDbtRunStream(options: UseDbtRunStreamOptions) {
    const {
        projectId,
        onLogLine,
        onCommandStart,
        onCommandComplete,
        onError,
        // autoConnect kept for API compatibility but unused — SSE connects per sendCommand
    } = options;

    const initialStream = activeStreams.get(projectId);
    const [isConnected, setIsConnected] = useState(initialStream?.isConnected ?? false);
    const [isConnecting, setIsConnecting] = useState(initialStream?.isConnecting ?? false);

    const onLogLineRef = useRef(onLogLine);
    const onCommandStartRef = useRef(onCommandStart);
    const onCommandCompleteRef = useRef(onCommandComplete);
    const onErrorRef = useRef(onError);
    const listenerRef = useRef<StreamListener | null>(null);

    useEffect(() => {
        onLogLineRef.current = onLogLine;
        onCommandStartRef.current = onCommandStart;
        onCommandCompleteRef.current = onCommandComplete;
        onErrorRef.current = onError;
    }, [onLogLine, onCommandStart, onCommandComplete, onError]);

    useEffect(() => {
        const handleMessage = (msg: DbtRunEvent) => {
            if (msg.type === 'started' && msg.command) {
                onCommandStartRef.current?.(msg.command);
            } else if (msg.type === 'output' && msg.line !== undefined) {
                onLogLineRef.current?.(msg.line);
            } else if (msg.type === 'completed' && msg.returncode !== undefined) {
                onCommandCompleteRef.current?.(msg.returncode);
            } else if (msg.type === 'error' && msg.error) {
                onErrorRef.current?.(msg.error);
            }
        };
        const listener: StreamListener = {
            onMessage: handleMessage,
            onStatusChange: (connected, connecting) => {
                setIsConnected(connected);
                setIsConnecting(connecting);
            },
        };
        listenerRef.current = listener;
        const stream = activeStreams.get(projectId);
        if (!stream) {
            return () => {
                listenerRef.current = null;
            };
        }

        stream.listeners.add(listener);
        listener.onStatusChange(stream.isConnected, stream.isConnecting);
        stream.backgroundMessages.splice(0).forEach(handleMessage);

        return () => {
            stream.listeners.delete(listener);
            listenerRef.current = null;
        };
    }, [projectId]);

    /** No-op — SSE connects per-command. Kept for API compatibility. */
    const connect = useCallback((): Promise<boolean> => {
        return Promise.resolve(true);
    }, []);

    const disconnect = useCallback(() => {
        const stream = activeStreams.get(projectId);
        stream?.controller.abort();
        if (stream) {
            stream.isConnected = false;
            stream.isConnecting = false;
            emitStatus(stream);
        }
    }, [projectId]);

    const sendCommand = useCallback((command: string, selector?: string, environmentVariables?: Record<string, string>, flags?: string[]): boolean => {
        const dbtRunnerUrl = getDbtRunnerUrl();
        const url = `${dbtRunnerUrl}/sse/dbt/${projectId}`;

        // Cancel any in-flight command for this project before replacing it.
        const previousStream = activeStreams.get(projectId);
        previousStream?.controller.abort();
        const controller = new AbortController();
        const listeners = previousStream?.listeners ?? new Set<StreamListener>();
        if (listenerRef.current) listeners.add(listenerRef.current);
        const stream: ActiveStream = {
            controller,
            listeners,
            backgroundMessages: [],
            isConnected: false,
            isConnecting: true,
        };
        activeStreams.set(projectId, stream);
        emitStatus(stream);

        (async () => {
            try {
                const session = await getSession();
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (session?.accessToken) {
                    headers.Authorization = `Bearer ${session.accessToken}`;
                }
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ command, selector, flags, environment_variables: environmentVariables }),
                    signal: controller.signal,
                });

                if (!response.ok || !response.body) {
                    emitMessage(stream, { type: 'error', error: `dbt runner returned ${response.status}` });
                    return;
                }

                stream.isConnected = true;
                stream.isConnecting = false;
                emitStatus(stream);

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() ?? '';

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        try {
                            const msg: DbtRunEvent = JSON.parse(line.slice(6));
                            emitMessage(stream, msg);
                        } catch (err) {
                            console.warn('[useDbtRunStream] malformed SSE line:', line, err);
                        }
                    }
                }
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    const msg = err instanceof Error ? err.message : 'Network error';
                    emitMessage(stream, { type: 'error', error: msg });
                }
            } finally {
                stream.isConnected = false;
                stream.isConnecting = false;
                if (activeStreams.get(projectId) === stream) {
                    emitStatus(stream);
                }
            }
        })();

        return true;
    }, [projectId]);

    return { isConnected, isConnecting, connect, disconnect, sendCommand };
}
