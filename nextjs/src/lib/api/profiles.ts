/**
 * Profiles API - dbt profiles.yml generation
 * 
 * API for generating profiles.yml configuration
 */

import { apiClient } from './client';

// Types
export interface ProfilesGenerateRequest {
    project_id: string;
    project_name: string;
    dremio_host: string;
    dremio_port: number;
    dremio_token: string;
    dremio_space: string;
}

export interface ProfilesGenerateResponse {
    success: boolean;
    message?: string;
    error?: string;
}

/**
 * Generate profiles.yml for a dbt project
 */
export async function generateProfiles(
    request: ProfilesGenerateRequest
): Promise<ProfilesGenerateResponse> {
    return apiClient.post<ProfilesGenerateResponse>('/profiles/generate', request);
}

/**
 * Profiles API namespace
 */
export const profilesApi = {
    generate: generateProfiles,
};
