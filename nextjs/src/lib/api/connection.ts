/**
 * Connection API - Connection testing and management
 * 
 * API for testing database connections
 */

import { apiClient } from './client';

// Types
export interface ConnectionTestRequest {
    type: string;
    name: string;
    config: Record<string, unknown>;
}

export interface ConnectionTestResponse {
    success: boolean;
    message: string;
    details?: string;
}

/**
 * Test a database connection
 */
export async function testConnection(
    request: ConnectionTestRequest
): Promise<ConnectionTestResponse> {
    return apiClient.post<ConnectionTestResponse>('/connection/test', request);
}

/**
 * Connection API namespace
 */
export const connectionApi = {
    test: testConnection,
};
