/**
 * dbt-runner API: File operations
 */

import { apiClient } from './client';

// Types
export interface FileNode {
    name: string;
    path: string;
    type: 'file' | 'folder';
    size?: number;
}

export interface FileListResponse {
    path: string;
    items: FileNode[];
}

export interface FileContentResponse {
    path: string;
    content: string;
}

export interface FileSaveResponse {
    success: boolean;
    path: string;
    message?: string;
}

export interface FileCreateRequest {
    path: string;
    file_type: 'file' | 'directory';
    content?: string;
}

export interface FileCreateResponse {
    success: boolean;
    message: string;
    path: string;
}

export interface FileDeleteResponse {
    success: boolean;
    message: string;
}

export interface FileRenameResponse {
    success: boolean;
    message: string;
    old_path: string;
    new_path: string;
}

export interface FileSearchResponse {
    query: string;
    results: FileNode[];
}

export interface FileMoveResponse {
    success: boolean;
    message: string;
    source_path: string;
    dest_path: string;
}

export interface FileCopyResponse {
    success: boolean;
    message: string;
    source_path: string;
    dest_path: string;
}

export interface FileDuplicateResponse {
    success: boolean;
    message: string;
    original_path: string;
    new_path: string;
}

export interface ProjectStatusResponse {
    project_id: string;
    exists: boolean;
    has_git: boolean;
    has_dbt_project: boolean;
    has_uncommitted_changes: boolean;
    file_count: number;
    path: string;
}

// API Functions
export const filesApi = {
    /**
     * List files in a project directory
     */
    list: (projectId: string, path: string = '') => {
        const queryPath = path ? `?path=${encodeURIComponent(path)}` : '';
        return apiClient.get<FileListResponse>(`/files/${projectId}${queryPath}`);
    },

    /**
     * Read file content
     */
    read: (projectId: string, path: string) =>
        apiClient.get<FileContentResponse>(
            `/files/${projectId}/content?path=${encodeURIComponent(path)}`
        ),

    /**
     * Save file content
     */
    save: (projectId: string, path: string, content: string) =>
        apiClient.post<FileSaveResponse>(`/files/${projectId}/content`, {
            path,
            content,
        }),

    /**
     * Create a new file or directory
     */
    create: (projectId: string, request: FileCreateRequest) =>
        apiClient.post<FileCreateResponse>(`/files/${projectId}/create`, request),

    /**
     * Delete a file or directory
     */
    delete: (projectId: string, path: string) =>
        apiClient.delete<FileDeleteResponse>(
            `/files/${projectId}?path=${encodeURIComponent(path)}`
        ),

    /**
     * Rename a file or directory
     */
    rename: (projectId: string, oldPath: string, newPath: string) =>
        apiClient.put<FileRenameResponse>(
            `/files/${projectId}/rename?old_path=${encodeURIComponent(oldPath)}&new_path=${encodeURIComponent(newPath)}`
        ),

    /**
     * Search for files in a project
     */
    search: (projectId: string, query: string) =>
        apiClient.get<FileSearchResponse>(
            `/files/${projectId}/search?query=${encodeURIComponent(query)}`
        ),

    /**
     * Move a file or directory to a new location
     */
    move: (projectId: string, sourcePath: string, destPath: string) =>
        apiClient.post<FileMoveResponse>(
            `/files/${projectId}/move?source_path=${encodeURIComponent(sourcePath)}&dest_path=${encodeURIComponent(destPath)}`
        ),

    /**
     * Copy a file or directory to a new location
     */
    copy: (projectId: string, sourcePath: string, destPath: string) =>
        apiClient.post<FileCopyResponse>(
            `/files/${projectId}/copy?source_path=${encodeURIComponent(sourcePath)}&dest_path=${encodeURIComponent(destPath)}`
        ),

    /**
     * Duplicate a file or directory in the same location
     */
    duplicate: (projectId: string, path: string) =>
        apiClient.post<FileDuplicateResponse>(
            `/files/${projectId}/duplicate?path=${encodeURIComponent(path)}`
        ),

    /**
     * Get project status - check if project exists and its state
     */
    getStatus: (projectId: string) =>
        apiClient.get<ProjectStatusResponse>(`/files/${projectId}/status`),
};

