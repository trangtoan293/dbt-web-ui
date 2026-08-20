/**
 * API Layer - Barrel Export
 * 
 * Usage:
 *   import { dbtApi, filesApi, gitApi } from '@/lib/api';
 *   
 *   // dbt commands
 *   const result = await dbtApi.runCommand(projectId, 'run');
 *   
 *   // File operations
 *   const files = await filesApi.list(projectId);
 *   
 *   // Git operations
 *   const branches = await gitApi.getBranches(projectId);
 */

export { apiClient, ApiClient, getDbtRunnerUrl, type ApiResponse, type ApiError } from './client';
export { dbtApi } from './dbt';
export { profilesApi, type ProfilesGenerateRequest, type ProfilesGenerateResponse } from './profiles';
export { connectionApi, type ConnectionTestRequest, type ConnectionTestResponse } from './connection';
export { filesApi } from './files';
export { gitApi } from './git';
export { envVarsApi } from './env-vars';

export type {
    DbtEnvironmentVariableInput,
    DbtEnvironmentVariableMeta,
    DbtEnvironmentVariableType,
} from './env-vars';

/**
 * Convenience re-exports for common types
 */
export type {
    DbtCommandRequest,
    DbtCommandResponse,
    DbtCompileRequest,
    DbtCompileResponse,
    DbtPreviewRequest,
    DbtPreviewResponse,
    DbtLineageResponse,
    DbtInitRequest,
    DbtInitResponse,
    DbtIntellisenseColumn,
    DbtIntellisenseModel,
    DbtIntellisenseSource,
    DbtIntellisenseMacro,
    DbtIntellisenseDoc,
    DbtIntellisenseResponse,
    DocsGenerateRequest,
    DocsGenerateResponse,
    DocsServeRequest,
    DocsServeResponse,
    DocsStatusResponse,
} from './dbt';

export type {
    FileNode,
    FileListResponse,
    FileContentResponse,
    FileSaveResponse,
    FileCreateRequest,
    FileCreateResponse,
    FileDeleteResponse,
    ProjectStatusResponse,
} from './files';

export type {
    GitBranch,
    GitRemote,
    GitBranchesResponse,
    GitRemotesResponse,
    GitConfigResponse,
    GitStatusResponse,
    GitCloneRequest,
    GitCloneResponse,
    GitCheckoutRequest,
    GitCheckoutResponse,
    GitCommitRequest,
    GitCommitResponse,
    GitPushRequest,
    GitPushResponse,
    GitExecResponse,
    GitInitRequest,
    GitInitResponse,
    // New types for Source Control
    GitAddResponse,
    GitResetResponse,
    GitDiffResponse,
    GitCommitInfo,
    GitLogResponse,
} from './git';
