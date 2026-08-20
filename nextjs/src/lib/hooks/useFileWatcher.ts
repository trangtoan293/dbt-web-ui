/**
 * useFileWatcher - React hook for real-time file system event monitoring
 *
 * Connects to SSE endpoint to receive file change notifications.
 * Uses EventSource (browser-native SSE) instead of WebSocket.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { getDbtRunnerUrl } from '@/lib/api/client';

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
    const esRef = useRef<EventSource | null>(null);
    const shouldConnectRef = useRef(true);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const onEventRef = useRef(onEvent);
    const onConnectRef = useRef(onConnect);
    const onDisconnectRef = useRef(onDisconnect);

    useEffect(() => {
        onEventRef.current = onEvent;
        onConnectRef.current = onConnect;
        onDisconnectRef.current = onDisconnect;
    }, [onEvent, onConnect, onDisconnect]);

    const connect = useCallback(() => {
        if (!projectId || esRef.current) return;

        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        const baseUrl = getDbtRunnerUrl();
        const url = `${baseUrl}/sse/files/${projectId}`;
        console.log(`[FileWatcher] Connecting to ${url}`);

        const es = new EventSource(url);
        esRef.current = es;

        es.onopen = () => {
            console.log(`[FileWatcher] Connected to project: ${projectId}`);
            setConnected(true);
            onConnectRef.current?.();
        };

        es.onmessage = (event) => {
            try {
                const data: FileWatcherEvent = JSON.parse(event.data);

                if (data.type === 'connected') {
                    console.log(`[FileWatcher] ${data.message}`);
                    return;
                }
                if (data.type === 'ping') return;
                if (data.type === 'error') {
                    console.error(`[FileWatcher] Error: ${data.message}`);
                    onEventRef.current(data);
                    return;
                }

                console.debug(`[FileWatcher] Event: ${data.type} - ${data.path}`);
                onEventRef.current(data);
            } catch (err) {
                console.error('[FileWatcher] Failed to parse message:', err);
            }
        };

        es.onerror = () => {
            console.log(`[FileWatcher] Connection error`);
            setConnected(false);
            esRef.current?.close();
            esRef.current = null;
            onDisconnectRef.current?.();

            if (autoReconnect && shouldConnectRef.current) {
                console.log(`[FileWatcher] Reconnecting in ${reconnectDelay}ms...`);
                reconnectTimeoutRef.current = setTimeout(connect, reconnectDelay);
            }
        };
    }, [projectId, autoReconnect, reconnectDelay]);

    const disconnect = useCallback(() => {
        shouldConnectRef.current = false;
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }
        esRef.current?.close();
        esRef.current = null;
        setConnected(false);
    }, []);

    const reconnect = useCallback(() => {
        disconnect();
        shouldConnectRef.current = true;
        setTimeout(connect, 100);
    }, [connect, disconnect]);

    useEffect(() => {
        shouldConnectRef.current = true;
        connect();

        return () => {
            shouldConnectRef.current = false;
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            esRef.current?.close();
            esRef.current = null;
        };
    }, [connect]);

    return { connected, reconnect, disconnect };
}
