/**
 * dbt-runner API: dbt commands
 */

import { apiClient } from './client';

// Types
export interface DbtQueryRequest {
    project_id: string;
    sql: string;
    limit?: number;
    /** profiles.yml output to query. Omitted means the project default. */
    target?: string;
    environment_variables?: Record<string, string>;
}

/** Same shape as a preview: both come from `dbt show`. */
export interface DbtQueryResponse {
    success: boolean;
    data: Record<string, unknown>[];
    columns: string[];
    column_types?: Record<string, string>;
    row_count: number;
    execution_time?: number;
    error?: string;
}

export interface DbtFormatResponse {
    formatted: boolean;
    sql: string;
    /** Why formatting was refused. Null when it succeeded. */
    reason: string | null;
}

export interface CronPreviewResponse {
    valid: boolean;
    message: string | null;
    /** ISO timestamps, UTC. */
    next_runs: string[];
}

export interface DbtCommandRequest {
    project_id: string;
    command: string;
    selector?: string;
    target?: string;
    flags?: string[];
    environment_variables?: Record<string, string>;
}

export interface DbtCommandResponse {
    success: boolean;
    command: string;
    stdout: string;
    stderr: string;
    returncode: number;
}

export interface DbtCompileRequest {
    project_id: string;
    model_path: string;
    additional_args?: string;
    environment_variables?: Record<string, string>;
}

export interface DbtCompileResponse {
    success: boolean;
    model: string;
    compiled_sql: string;
    output?: string;
    error?: string;
}

export interface DbtPreviewRequest {
    project_id: string;
    model_path: string;
    limit?: number;
    additional_args?: string;
    environment_variables?: Record<string, string>;
}

export interface DbtPreviewResponse {
    success: boolean;
    model: string;
    data: Record<string, unknown>[];
    columns: string[];
    column_types?: Record<string, string>;
    row_count: number;
    execution_time: number;
    error?: string;
    cancelled?: boolean;  // True when user clicked Cancel
    lock_timeout?: boolean;  // True when another operation is in progress
}

export interface DbtExplainRequest {
    project_id: string;
    model_path: string;
    additional_args?: string;
    environment_variables?: Record<string, string>;
}

export interface DbtExplainResponse {
    success: boolean;
    model: string;
    adapter: string;
    mode: 'Estimated';
    plan: string;
    signals: string[];
    execution_time: number;
    compiled_sql?: string;
    error?: string;
    stage?: 'compile' | 'explain';
}


export interface DbtLineageResponse {
    success: boolean;
    model: string;
    table_lineage: {
        nodes: { id: string; name: string; type: string; schema?: string; position?: string; columns?: string[] }[];
        edges: { from: string; to: string }[];
    };
    column_lineage: Record<string, { column: string; table: string; expression?: string }[]>;
    error?: string;
}

export interface DbtInitRequest {
    project_id: string;
    project_name: string;
}

export interface DbtInitResponse {
    success: boolean;
    message: string;
    path?: string;
}

export interface DbtIntellisenseColumn {
    name: string;
    data_type?: string | null;
    description?: string | null;
}

export interface DbtIntellisenseModel {
    name: string;
    unique_id: string;
    path: string;
    description?: string | null;
    columns: DbtIntellisenseColumn[];
}

export interface DbtIntellisenseSource {
    source_name: string;
    table_name: string;
    unique_id: string;
    path: string;
    description?: string | null;
    columns: DbtIntellisenseColumn[];
}

export interface DbtIntellisenseMacro {
    name: string;
    package_name?: string | null;
    unique_id: string;
    path: string;
    description?: string | null;
    arguments: Array<Record<string, unknown>>;
}

export interface DbtIntellisenseDoc {
    name: string;
    unique_id: string;
    path: string;
}

export interface DbtIntellisenseResponse {
    success: boolean;
    status: 'ready' | 'missing_manifest' | 'parse_error';
    generated_at?: string | null;
    catalog_available: boolean;
    models: DbtIntellisenseModel[];
    sources: DbtIntellisenseSource[];
    macros: DbtIntellisenseMacro[];
    docs: DbtIntellisenseDoc[];
}

// ==================== DOCS TYPES ====================

export interface DocsGenerateRequest {
    project_id: string;
    select?: string;
}

export interface DocsGenerateResponse {
    success: boolean;
    message: string;
    catalog_path?: string;
    manifest_path?: string;
    stdout?: string;
    stderr?: string;
}

export interface DocsServeRequest {
    project_id: string;
    port?: number;
}

export interface DocsServeResponse {
    success: boolean;
    message: string;
    url?: string;
    port?: number;
}

export interface DocsStatusResponse {
    running: boolean;
    url?: string;
    port?: number;
    project_id: string;
}

// API Functions
export const dbtApi = {
    /**
     * Execute a dbt command (run, test, build, compile, etc.)
     */
    runCommand: (projectId: string, command: string, environmentVariables?: Record<string, string>, flags?: string[]) =>
        apiClient.post<DbtCommandResponse>('/dbt/command', {
            project_id: projectId,
            command,
            flags,
            environment_variables: environmentVariables,
        }),

    /**
     * Start a run in the background and return its id. Same path the scheduler
     * uses, so a manual "run now" and a cron fire behave identically.
     */
    startRun: (request: DbtCommandRequest) =>
        apiClient.post<{ id: string; run_id: string; project_id: string; status: string; started_at: string }>(
            '/dbt/runs',
            request,
        ),

    /**
     * Run a read-only inline SELECT (dbt show --inline), so ad-hoc SQL goes
     * through the project's own profile and macros.
     */
    query: (projectId: string, sql: string, limit: number = 100, target?: string, environmentVariables?: Record<string, string>) =>
        apiClient.post<DbtQueryResponse>('/dbt/query', {
            project_id: projectId,
            sql,
            limit,
            target,
            environment_variables: environmentVariables,
        }),

    /**
     * Pretty-print SQL, keeping Jinja intact. Returns formatted:false with a
     * reason when the round trip cannot be verified - do not overwrite the
     * editor in that case.
     */
    format: (sql: string, dialect?: string) =>
        apiClient.post<DbtFormatResponse>('/dbt/format', { sql, dialect }),

    /**
     * Validate a cron expression and preview when it would fire (UTC).
     */
    previewCron: (expression: string, count: number = 5) =>
        apiClient.get<CronPreviewResponse>(
            `/dbt/cron/preview?expression=${encodeURIComponent(expression)}&count=${count}`,
        ),

    /**
     * Compile a specific model and get SQL
     */
    compile: (projectId: string, modelPath: string, additionalArgs?: string, environmentVariables?: Record<string, string>) =>
        apiClient.post<DbtCompileResponse>('/dbt/compile', {
            project_id: projectId,
            model_path: modelPath,
            additional_args: additionalArgs,
            environment_variables: environmentVariables,
        }),

    /**
     * Preview model data (dbt show)
     */
    preview: (projectId: string, modelPath: string, limit: number = 100, additionalArgs?: string, environmentVariables?: Record<string, string>) =>
        apiClient.post<DbtPreviewResponse>('/dbt/preview', {
            project_id: projectId,
            model_path: modelPath,
            limit,
            additional_args: additionalArgs,
            environment_variables: environmentVariables,
        }),

    /**
     * Explain model query plan without ANALYZE.
     */
    explain: (projectId: string, modelPath: string, additionalArgs?: string, environmentVariables?: Record<string, string>) =>
        apiClient.post<DbtExplainResponse>('/dbt/explain', {
            project_id: projectId,
            model_path: modelPath,
            additional_args: additionalArgs,
            environment_variables: environmentVariables,
        }),

    /**
     * Initialize a new dbt project
     */
    init: (projectId: string, projectName: string) =>
        apiClient.post<DbtInitResponse>('/dbt/init', {
            project_id: projectId,
            project_name: projectName,
        }),

    /**
     * Get normalized dbt metadata for editor autocomplete and definitions
     */
    getIntellisense: (projectId: string) =>
        apiClient.get<DbtIntellisenseResponse>(`/dbt/intellisense/${projectId}`),

    /**
     * Get table + column lineage for a model.
     */
    getLineage: (projectId: string, modelPath: string) =>
        apiClient.post<DbtLineageResponse>('/dbt/lineage', {
            project_id: projectId,
            model_path: modelPath,
        }),

    /**
     * Regenerate profiles.yml from the project's stored connection.
     * Call after switching connection so profiles.yml updates immediately.
     */
    regenerateProfiles: (projectId: string) =>
        apiClient.post<{ success: boolean; regenerated: boolean }>(
            `/dbt/regenerate-profiles/${projectId}`,
            {},
        ),

    // ==================== DOCS OPERATIONS ====================

    /**
     * Generate dbt documentation (catalog.json, manifest.json)
     */
    generateDocs: (projectId: string, select?: string) =>
        apiClient.post<DocsGenerateResponse>('/dbt/docs/generate', {
            project_id: projectId,
            select,
        }),

    /**
     * Start dbt docs server
     */
    serveDocs: (projectId: string, port?: number) =>
        apiClient.post<DocsServeResponse>('/dbt/docs/serve', {
            project_id: projectId,
            port,
        }),

    /**
     * Stop dbt docs server
     */
    stopDocs: (projectId: string) =>
        apiClient.post<{ success: boolean; message: string }>(`/dbt/docs/stop?project_id=${projectId}`, {}),

    /**
     * Get docs server status
     */
    getDocsStatus: (projectId: string) =>
        apiClient.get<DocsStatusResponse>(`/dbt/docs/status?project_id=${projectId}`),

    /**
     * List all active docs servers
     */
    listDocsServers: () =>
        apiClient.get<{
            servers: { project_id: string; url: string; port: number; running: boolean }[];
            count: number;
        }>('/dbt/docs/list'),
};
