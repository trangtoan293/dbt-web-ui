/**
 * useFileWatcher - React hook for real-time file system event monitoring
 *
 * Connects to SSE endpoint to receive file change notifications.
 *
 * fetch + ReadableStream, not EventSource - same reason useDbtRunStream and
 * useIngestStream do it that way: EventSource cannot send an Authorization
 * header, and this endpoint now requires one (project-permission checked,
 * see docs/rbac-design.md). Goes through the same-origin `/api/dbt-runner`
 * proxy rather than the runner's own origin directly, per src/lib/api/proxy.ts
 * - the browser never holds the service's address.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { getSession } from 'next-auth/react';

export interface FileWatcherEvent {
    type: 'created' | 'modified' | 'deleted' | 'moved' | 'connected' | 'error' | 'ping';
    path?: string;
    new_path?: string;
    timestamp?: string;
    message?: string;
    project_id?: string;
}

export interface UseFileWatcherOptions {
    onEvent: (event: FileWatcherEvent) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    autoReconnect?: boolean;
    reconnectDelay?: number;
}

export interface UseFileWatcherReturn {
    connected: boolean;
    reconnect: () => void;
    disconnect: () => void;
}

export function useFileWatcher(
    projectId: string,
    options: UseFileWatcherOptions
): UseFileWatcherReturn {
    const {
        onEvent,
        onConnect,
        onDisconnect,
        autoReconnect = true,
        reconnectDelay = 2000,
    } = options;

    const [connected, setConnected] = useState(false);
    const controllerRef = useRef<AbortController | null>(null);
    const shouldConnectRef = useRef(true);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const connectRef = useRef<() => void>(() => {});

    const onEventRef = useRef(onEvent);
    const onConnectRef = useRef(onConnect);
    const onDisconnectRef = useRef(onDisconnect);

    useEffect(() => {
        onEventRef.current = onEvent;
        onConnectRef.current = onConnect;
        onDisconnectRef.current = onDisconnect;
    }, [onEvent, onConnect, onDisconnect]);

    const scheduleReconnect = useCallback(() => {
        if (!autoReconnect || !shouldConnectRef.current) return;
        console.log(`[FileWatcher] Reconnecting in ${reconnectDelay}ms...`);
        reconnectTimeoutRef.current = setTimeout(() => connectRef.current(), reconnectDelay);
    }, [autoReconnect, reconnectDelay]);

    const connect = useCallback(() => {
        if (!projectId || controllerRef.current) return;

        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        const controller = new AbortController();
        controllerRef.current = controller;
        const url = `/api/dbt-runner/sse/files/${projectId}`;
        console.log(`[FileWatcher] Connecting to ${url}`);

        (async () => {
            try {
                const session = await getSession();
                const headers: Record<string, string> = {};
                if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;

                const response = await fetch(url, { headers, signal: controller.signal });
                if (!response.ok || !response.body) {
                    console.log(`[FileWatcher] Connection error: ${response.status}`);
                    return;
                }

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
                        let data: FileWatcherEvent;
                        try {
                            data = JSON.parse(line.slice(6));
                        } catch (err) {
                            console.error('[FileWatcher] Failed to parse message:', err);
                            continue;
                        }

                        if (data.type === 'connected') {
                            // The backend sends this exactly once, right after
                            // accepting the connection - no staleness risk from
                            // not depending on `connected` here.
                            console.log(`[FileWatcher] ${data.message}`);
                            setConnected(true);
                            onConnectRef.current?.();
                            continue;
                        }
                        if (data.type === 'ping') continue;
                        if (data.type === 'error') {
                            console.error(`[FileWatcher] Error: ${data.message}`);
                            onEventRef.current(data);
                            continue;
                        }

                        console.debug(`[FileWatcher] Event: ${data.type} - ${data.path}`);
                        onEventRef.current(data);
                    }
                }
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    console.log('[FileWatcher] Connection error', err);
                }
            } finally {
                if (controllerRef.current === controller) {
                    controllerRef.current = null;
                }
                setConnected(false);
                onDisconnectRef.current?.();
                scheduleReconnect();
            }
        })();
    }, [projectId, scheduleReconnect]);

    useEffect(() => {
        connectRef.current = connect;
    }, [connect]);

    const disconnect = useCallback(() => {
        shouldConnectRef.current = false;
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        controllerRef.current?.abort();
        controllerRef.current = null;
        setConnected(false);
    }, []);

    const reconnect = useCallback(() => {
        disconnect();
        shouldConnectRef.current = true;
        setTimeout(() => connectRef.current(), 100);
    }, [disconnect]);

    useEffect(() => {
        shouldConnectRef.current = true;
        connect();

        return () => {
            shouldConnectRef.current = false;
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            controllerRef.current?.abort();
            controllerRef.current = null;
        };
    }, [connect]);

    return { connected, reconnect, disconnect };
}
