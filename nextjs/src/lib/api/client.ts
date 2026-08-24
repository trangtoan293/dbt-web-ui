/**
 * Centralized API client for dbt-runner service.
 * All API calls should go through this module.
 */

import { getSession } from 'next-auth/react'

/**
 * Where to reach dbt-runner.
 *
 * In the browser: always the Next.js proxy route, so the backend needs no
 * public exposure and the proxy can attach auth.
 *
 * On the server (the proxy itself, and SSR): the internal address. This must
 * NOT come from a browser-facing URL — inside a container `localhost` is the
 * frontend itself, which is how this silently 500s for every backend call.
 */
export function getDbtRunnerUrl(): string {
    if (typeof window !== 'undefined') {
        return '/api/dbt-runner';
    }
    return process.env.DBT_RUNNER_URL || 'http://localhost:8080';
}

// Same shape as getDbtRunnerUrl: an internal service address nobody configures.
// A deployment that does not want the assistant sets AGENT_URL empty, and the
// proxy route then answers 503, which is what hides the panel.
export function getAgentUrl(): string {
    if (typeof window !== 'undefined') {
        return '/api/agent';
    }
    return process.env.AGENT_URL ?? 'http://dsh-agent:8090';
}

// Session ID management - persists across tabs
const SESSION_STORAGE_KEY = 'dbt-session-id';

const getSessionStorageKey = (userId?: string | null) =>
    userId ? `${SESSION_STORAGE_KEY}:${userId}` : SESSION_STORAGE_KEY;

// Generate UUID with fallback for older environments
export function generateUUID(): string {
    // Try crypto.randomUUID first (modern browsers/Node 19+)
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback for older environments
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function getSessionId(userId?: string | null): string {
    // Check if running in browser
    if (typeof window === 'undefined') {
        return '';
    }

    const storageKey = getSessionStorageKey(userId);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    let sessionId = localStorage.getItem(storageKey);
    if (!sessionId) {
        sessionId = generateUUID();
        localStorage.setItem(storageKey, sessionId);
    }
    return sessionId;
}

export function resetSessionId(userId?: string | null): string {
    if (typeof window === 'undefined') {
        return '';
    }
    const newSessionId = generateUUID();
    localStorage.setItem(getSessionStorageKey(userId), newSessionId);
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return newSessionId;
}

export function getCurrentSessionId(userId?: string | null): string {
    return getSessionId(userId);
}

export interface ApiResponse<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
    error?: string;
}

export interface ApiError {
    message: string;
    status: number;
    details?: unknown;
}

class ApiClient {
    private getBaseUrl(): string {
        return getDbtRunnerUrl();
    }

    private async request<T>(
        path: string,
        options: RequestInit = {}
    ): Promise<T> {
        const url = `${this.getBaseUrl()}${path}`;

        let userId: string | undefined
        let accessToken: string | undefined

        // Attach the OIDC access token for dbt-runner auth
        if (typeof window !== 'undefined') {
            try {
                const session = await getSession()
                userId = session?.user?.id
                if (session?.error) {
                    window.location.href = '/login'
                    throw new Error('Session expired. Please sign in again.')
                }
                if (session?.accessToken) {
                    accessToken = session.accessToken
                } else {
                    window.location.href = '/login'
                    throw new Error('Missing access token. Please sign in again.')
                }
            } catch (error) {
                if (error instanceof Error) {
                    throw {
                        message: error.message,
                        status: 401,
                        details: { error: 'auth' },
                    } as ApiError
                }
            }
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Session-ID': getSessionId(userId),
            ...(options.headers as Record<string, string>),
        }
        if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

        const response = await fetch(url, {
            ...options,
            headers,
        });

        // Update session ID from response if server provides one
        const serverSessionId = response.headers.get('X-Session-ID');
        if (serverSessionId && typeof window !== 'undefined') {
            localStorage.setItem(getSessionStorageKey(userId), serverSessionId);
            localStorage.removeItem(SESSION_STORAGE_KEY);
        }

        const data = await response.json();

        if (!response.ok) {
            throw {
                message: data.message || data.detail || 'API request failed',
                status: response.status,
                details: data,
            } as ApiError;
        }

        return data;
    }

    async get<T>(path: string): Promise<T> {
        return this.request<T>(path, { method: 'GET' });
    }

    async post<T>(path: string, body?: unknown): Promise<T> {
        return this.request<T>(path, {
            method: 'POST',
            body: body ? JSON.stringify(body) : undefined,
        });
    }

    async put<T>(path: string, body?: unknown): Promise<T> {
        return this.request<T>(path, {
            method: 'PUT',
            body: body ? JSON.stringify(body) : undefined,
        });
    }

    async delete<T>(path: string): Promise<T> {
        return this.request<T>(path, { method: 'DELETE' });
    }
}

// Export singleton instance
export const apiClient = new ApiClient();

// Export class for testing or custom instances
export { ApiClient };
