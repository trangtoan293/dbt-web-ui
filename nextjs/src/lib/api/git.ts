/**
 * dbt-runner API: Git operations
 */

import { apiClient } from './client';

// Types
export interface GitBranch {
    name: string;
    is_current: boolean;
    is_remote: boolean;
}

export interface GitRemote {
    name: string;
    fetch_url: string;
    push_url: string;
}

export interface GitBranchesResponse {
    success: boolean;
    branches: GitBranch[];
    current: string;
}

export interface GitRemotesResponse {
    success: boolean;
    remotes: GitRemote[];
}

export interface GitConfigResponse {
    success: boolean;
    user_name: string;
    user_email: string;
}

export interface GitStatusResponse {
    success: boolean;
    clean: boolean;
    changes: { status: string; path: string }[];
    no_repo?: boolean;
    error?: string;
}

export interface GitCloneRequest {
    project_id: string;
    git_url: string;
    branch?: string;
}

export interface GitCloneResponse {
    success: boolean;
    message: string;
    path?: string;
    detail?: string;
}

export interface GitCheckoutRequest {
    project_id: string;
    branch: string;
}

export interface GitCheckoutResponse {
    success: boolean;
    message: string;
}

export interface GitCommitRequest {
    project_id: string;
    message: string;
}

export interface GitCommitResponse {
    success: boolean;
    message: string;
    commit_hash?: string;
    nothing_staged?: boolean;
    stdout?: string;
    stderr?: string;
}

export interface GitPushRequest {
    project_id: string;
    remote?: string;
    branch?: string;
    force?: boolean;
    username?: string;
    token?: string;
}

export interface GitPushResponse {
    success: boolean;
    message: string;
    stdout?: string;
    stderr?: string;
    branch?: string;
}

export interface GitExecResponse {
    success: boolean;
    stdout: string;
    stderr: string;
}

// New types for Source Control
export interface GitAddResponse {
    success: boolean;
    message: string;
    files: string[];
}

export interface GitResetResponse {
    success: boolean;
    message: string;
    hard: boolean;
}

export interface GitDiffResponse {
    success: boolean;
    unstaged_diff: string;
    staged_diff: string;
}

export interface GitCommitInfo {
    hash: string;
    author: string;
    email: string;
    date: string;
    message: string;
}

export interface GitLogResponse {
    success: boolean;
    commits: GitCommitInfo[];
}

export interface GitInitRequest {
    project_id: string;
    remote_url?: string;
    branch?: string;
}

export interface GitInitResponse {
    success: boolean;
    message: string;
    already_exists?: boolean;
    path?: string;
    branch?: string;
    remote?: string;
}

export interface GitRemoteResponse {
    success: boolean;
    message: string;
    remote_name: string;
    remote_url: string;
}

// API Functions
export const gitApi = {
    /**
     * Initialize a git repository for a project
     */
    init: (projectId: string, remoteUrl?: string, branch: string = 'main') =>
        apiClient.post<GitInitResponse>('/git/init', {
            project_id: projectId,
            remote_url: remoteUrl,
            branch,
        }),

    /**
     * Clone a git repository
     */
    clone: (
        projectId: string,
        gitUrl: string,
        branch: string = 'main',
        username?: string,
        token?: string
    ) =>
        apiClient.post<GitCloneResponse>('/git/clone', {
            project_id: projectId,
            git_url: gitUrl,
            branch,
            username,
            token,
        }),

    /**
     * Get list of branches
     */
    getBranches: (projectId: string) =>
        apiClient.get<GitBranchesResponse>(`/git/branches/${projectId}`),

    /**
     * Get list of remotes
     */
    getRemotes: (projectId: string) =>
        apiClient.get<GitRemotesResponse>(`/git/remotes/${projectId}`),

    /**
     * Add or update a remote
     */
    addRemote: (projectId: string, remoteName: string, remoteUrl: string) =>
        apiClient.post<GitRemoteResponse>('/git/remote/add', {
            project_id: projectId,
            remote_name: remoteName,
            remote_url: remoteUrl,
        }),

    /**
     * Get git config (user name/email)
     */
    getConfig: (projectId: string) =>
        apiClient.get<GitConfigResponse>(`/git/config/${projectId}`),

    /**
     * Get git status
     */
    getStatus: (projectId: string) =>
        apiClient.get<GitStatusResponse>(`/git/status/${projectId}`),

    /**
     * Checkout a branch
     */
    checkout: (projectId: string, branch: string, create: boolean = false) =>
        apiClient.post<GitCheckoutResponse>('/git/checkout', {
            project_id: projectId,
            branch,
            create,
        }),

    /**
     * Commit changes
     * @param stageAll - If true, stages all changes before commit (like 'git commit -a')
     */
    commit: (projectId: string, message: string, stageAll: boolean = false) =>
        apiClient.post<GitCommitResponse>('/git/commit', {
            project_id: projectId,
            message,
            stage_all: stageAll,
        }),

    /**
     * Push to remote with optional credentials
     */
    push: (projectId: string, username?: string, token?: string, remote: string = 'origin', branch?: string, force: boolean = false) =>
        apiClient.post<GitPushResponse>('/git/push', {
            project_id: projectId,
            remote,
            branch,
            force,
            username,
            token,
        }),

    /**
     * Pull from remote with optional credentials
     */
    pull: (projectId: string, branch?: string, username?: string, token?: string) =>
        apiClient.post<{ success: boolean; output: string }>('/git/pull', {
            project_id: projectId,
            branch,
            username,
            token,
        }),

    /**
     * Execute arbitrary git command
     */
    exec: (projectId: string, command: string) =>
        apiClient.post<GitExecResponse>(
            `/git/exec?project_id=${projectId}&command=${encodeURIComponent(command)}`
        ),

    /**
     * Stage files for commit
     */
    add: (projectId: string, files?: string[]) => {
        const params = new URLSearchParams({ project_id: projectId });
        if (files && files.length > 0) {
            files.forEach(f => params.append('files', f));
        }
        return apiClient.post<GitAddResponse>(`/git/add?${params.toString()}`);
    },

    /**
     * Unstage files (reset)
     */
    reset: (projectId: string, files?: string[], hard: boolean = false) => {
        const params = new URLSearchParams({ project_id: projectId, hard: String(hard) });
        if (files && files.length > 0) {
            files.forEach(f => params.append('files', f));
        }
        return apiClient.post<GitResetResponse>(`/git/reset?${params.toString()}`);
    },

    /**
     * Get diff of changes
     */
    getDiff: (projectId: string, filePath?: string) =>
        apiClient.get<GitDiffResponse>(
            filePath
                ? `/git/diff/${projectId}?file_path=${encodeURIComponent(filePath)}`
                : `/git/diff/${projectId}`
        ),

    /**
     * Get commit history
     */
    getLog: (projectId: string, limit: number = 50) =>
        apiClient.get<GitLogResponse>(`/git/log/${projectId}?limit=${limit}`),

    /**
     * Fetch updates from all remotes
     */
    fetch: (projectId: string, username?: string, token?: string) =>
        apiClient.post<{ success: boolean; message: string; output?: string }>(`/git/fetch/${projectId}`, {
            username,
            token,
        }),
};
