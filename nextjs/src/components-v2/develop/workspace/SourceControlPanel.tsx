'use client';

/**
 * SourceControlPanel - VS Code-style Git Source Control UI
 * Matches app's Fluent UI light theme
 * 
 * Features:
 * - Stage/Unstage individual files or all
 * - Commit staged changes only (VSCode behavior)
 * - Commit All option (stage + commit)
 * - Discard changes
 * - Push/Pull with credential management
 * - Sync status (ahead/behind)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
    GitBranch,
    RefreshCw,
    Plus,
    Minus,
    Check,
    ChevronDown,
    ChevronRight,
    FileText,
    Upload,
    Download,
    X,
    Loader2,
    RotateCcw,
    ArrowUpDown,
} from 'lucide-react';
import { gitApi, type GitBranch as GitBranchInfo, type GitRemote } from '@/lib/api';
import { GitCredentialDialog, type GitOperationType } from '@/components-v2/develop/git';

interface FileChange {
    path: string;
    status: string;
    staged: boolean;
}

interface SourceControlPanelProps {
    projectId: string;
    onRefresh?: () => void;
    onOpenDiff?: (path: string) => void;
}

interface SyncStatus {
    ahead: number;
    behind: number;
}

/**
 * Parse git status code to determine staged/unstaged state
 * Git porcelain format: XY where X=staged status, Y=unstaged status
 * 
 * X (index/staged):
 *   ' ' = unmodified
 *   'M' = modified
 *   'A' = added
 *   'D' = deleted
 *   'R' = renamed
 *   'C' = copied
 *   '?' = untracked
 *   '!' = ignored
 * 
 * Y (working tree/unstaged):
 *   ' ' = unmodified
 *   'M' = modified
 *   'D' = deleted
 *   '?' = untracked
 * 
 * Examples:
 *   "M " = modified and staged (index has changes, working tree matches index)
 *   " M" = modified but not staged (index clean, working tree has changes)
 *   "MM" = modified, staged, then modified again (both have changes)
 *   "A " = new file staged
 *   "AM" = new file staged, then modified in working tree
 *   "??" = untracked file
 *   " D" = deleted in working tree but not staged
 *   "D " = deleted and staged
 */
function parseGitStatus(statusCode: string): { staged: boolean; stagedStatus: string; unstagedStatus: string } {
    // Handle untracked files
    if (statusCode === '??' || statusCode === '?') {
        return { staged: false, stagedStatus: '', unstagedStatus: '?' };
    }

    // Handle ignored files
    if (statusCode === '!!' || statusCode === '!') {
        return { staged: false, stagedStatus: '', unstagedStatus: '!' };
    }

    // Ensure we have 2 characters (pad with space if needed for old API compatibility)
    const normalizedStatus = statusCode.padEnd(2, ' ');

    const x = normalizedStatus.charAt(0); // Index/Staged status
    const y = normalizedStatus.charAt(1); // Working tree/Unstaged status

    // X position: staged changes (anything except space means staged)
    const hasStaged = x !== ' ' && x !== '?';
    const stagedLetter = hasStaged ? x : '';

    // Y position: unstaged changes (anything except space means unstaged)
    const hasUnstaged = y !== ' ' && y !== '?';
    const unstagedLetter = hasUnstaged ? y : '';

    return {
        staged: hasStaged,
        stagedStatus: stagedLetter,
        unstagedStatus: unstagedLetter,
    };
}

export default function SourceControlPanel({ projectId, onRefresh, onOpenDiff }: SourceControlPanelProps) {
    const [stagedChanges, setStagedChanges] = useState<FileChange[]>([]);
    const [unstagedChanges, setUnstagedChanges] = useState<FileChange[]>([]);
    const [commitMessage, setCommitMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [expandedStaged, setExpandedStaged] = useState(true);
    const [expandedChanges, setExpandedChanges] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [isNoRepo, setIsNoRepo] = useState(false);
    const [initLoading, setInitLoading] = useState(false);

    // Credential dialog state
    const [credDialog, setCredDialog] = useState<{
        isOpen: boolean;
        type: GitOperationType;
        error?: string;
    }>({ isOpen: false, type: 'push' });

    // Remote URL for credential lookup
    const [remoteUrl, setRemoteUrl] = useState<string>('');
    const [remotes, setRemotes] = useState<GitRemote[]>([]);
    const [showRemoteSettings, setShowRemoteSettings] = useState(false);
    const [remoteNameInput, setRemoteNameInput] = useState('origin');
    const [remoteUrlInput, setRemoteUrlInput] = useState('');
    const [remoteLoading, setRemoteLoading] = useState(false);

    // Branch state
    const [currentBranch, setCurrentBranch] = useState<string>('main');
    const [branches, setBranches] = useState<GitBranchInfo[]>([]);
    const [showNewBranch, setShowNewBranch] = useState(false);
    const [newBranchName, setNewBranchName] = useState('');
    const [branchLoading, setBranchLoading] = useState(false);

    // Sync status (ahead/behind)
    const [syncStatus, setSyncStatus] = useState<SyncStatus>({ ahead: 0, behind: 0 });

    const [showAdvanced, setShowAdvanced] = useState(false);

    // Load sync status (ahead/behind commits)
    const loadSyncStatus = useCallback(async () => {
        try {
            // Use git rev-list to count ahead/behind
            const result = await gitApi.exec(projectId, 'rev-list --left-right --count HEAD...@{upstream}');
            if (result.success && result.stdout) {
                const parts = result.stdout.trim().split(/\s+/);
                if (parts.length >= 2) {
                    setSyncStatus({
                        ahead: parseInt(parts[0]) || 0,
                        behind: parseInt(parts[1]) || 0,
                    });
                }
            }
        } catch {
            // Silently fail - upstream might not be set
            setSyncStatus({ ahead: 0, behind: 0 });
        }
    }, [projectId]);

    // Load git status and sync info
    const loadStatus = useCallback(async () => {
        setRefreshing(true);
        setError(null);
        try {
            // Load status
            const data = await gitApi.getStatus(projectId);
            if (!data.success && data.no_repo) {
                setIsNoRepo(true);
                return;
            }
            setIsNoRepo(false);
            if (data.success) {
                const staged: FileChange[] = [];
                const unstaged: FileChange[] = [];

                data.changes.forEach((c: { status: string; path: string }) => {
                    const parsed = parseGitStatus(c.status);

                    // A file can appear in both if it has staged AND unstaged changes (e.g., "MM")
                    if (parsed.staged) {
                        staged.push({
                            path: c.path,
                            status: parsed.stagedStatus,
                            staged: true,
                        });
                    }
                    if (parsed.unstagedStatus) {
                        unstaged.push({
                            path: c.path,
                            status: parsed.unstagedStatus,
                            staged: false,
                        });
                    }
                });

                setStagedChanges(staged);
                setUnstagedChanges(unstaged);
            }

            // Load remote URL for credential store
            const remotesData = await gitApi.getRemotes(projectId);
            setRemotes(remotesData.success ? remotesData.remotes : []);
            if (remotesData.success && remotesData.remotes.length > 0) {
                const origin = remotesData.remotes.find(r => r.name === 'origin');
                const preferredRemote = origin || remotesData.remotes[0];
                setRemoteUrl(preferredRemote.fetch_url);
                setRemoteNameInput(preferredRemote.name);
                setRemoteUrlInput(preferredRemote.fetch_url || preferredRemote.push_url);
            } else {
                setRemoteUrl('');
                setRemoteNameInput('origin');
                setRemoteUrlInput('');
            }

            // Load current branch
            try {
                const branchesData = await gitApi.getBranches(projectId);
                setBranches(branchesData.success ? branchesData.branches : []);
                if (branchesData.success && branchesData.current) {
                    setCurrentBranch(branchesData.current);
                }
            } catch {
                setBranches([]);
            }

            // Load sync status (ahead/behind)
            await loadSyncStatus();
        } catch (err) {
            setError('Failed to load git status');
            console.error(err);
        } finally {
            setRefreshing(false);
        }
    }, [loadSyncStatus, projectId]);

    useEffect(() => {
        loadStatus();
    }, [loadStatus]);

    // Get status display
    const getStatusDisplay = (status: string) => {
        switch (status) {
            case 'M':
                return { letter: 'M', color: 'text-[#B7791F]', bgColor: 'bg-[#FEF3C7]', label: 'Modified' };
            case 'A':
                return { letter: 'A', color: 'text-[#047857]', bgColor: 'bg-[#D1FAE5]', label: 'Added' };
            case 'D':
                return { letter: 'D', color: 'text-[#DC2626]', bgColor: 'bg-[#FEE2E2]', label: 'Deleted' };
            case 'R':
                return { letter: 'R', color: 'text-[#2563EB]', bgColor: 'bg-[#DBEAFE]', label: 'Renamed' };
            case '?':
                return { letter: 'U', color: 'text-[#6B7280]', bgColor: 'bg-[#F3F4F6]', label: 'Untracked' };
            default:
                return { letter: '?', color: 'text-[#6B7280]', bgColor: 'bg-[#F3F4F6]', label: status };
        }
    };

    // Stage a file
    const stageFile = async (path: string) => {
        try {
            await gitApi.add(projectId, [path]);
            await loadStatus();
        } catch (err) {
            setError('Failed to stage file');
            console.error(err);
        }
    };

    // Unstage a file
    const unstageFile = async (path: string) => {
        try {
            await gitApi.reset(projectId, [path]);
            await loadStatus();
        } catch (err) {
            setError('Failed to unstage file');
            console.error(err);
        }
    };

    // Stage all files
    const stageAll = async () => {
        try {
            await gitApi.add(projectId);
            await loadStatus();
        } catch (err) {
            setError('Failed to stage all');
            console.error(err);
        }
    };

    // Unstage all files
    const unstageAll = async () => {
        try {
            await gitApi.reset(projectId);
            await loadStatus();
        } catch (err) {
            setError('Failed to unstage all');
            console.error(err);
        }
    };

    // Main path for basic users: stage everything and commit in one step.
    const handleCommit = async () => {
        if (!commitMessage.trim()) {
            setError('Please enter a commit message');
            return;
        }

        if (totalChanges === 0) {
            setError('No changes to commit');
            return;
        }

        setLoading(true);
        setError(null);
        setSuccessMessage(null);

        try {
            const result = await gitApi.commit(projectId, commitMessage, true);

            if (result.success) {
                setCommitMessage('');
                setSuccessMessage('Committed all changes');
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
                onRefresh?.();
            } else {
                setError(result.stderr || result.message || 'Commit failed');
            }
        } catch (err) {
            setError('Failed to commit');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    // Commit all changes (stage all + commit) — retained for future use; not currently wired up.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const handleCommitAll = async () => {
        if (!commitMessage.trim()) {
            setError('Please enter a commit message');
            return;
        }

        if (totalChanges === 0) {
            setError('No changes to commit');
            return;
        }

        setLoading(true);
        setError(null);
        setSuccessMessage(null);

        try {
            const result = await gitApi.commit(projectId, commitMessage, true);

            if (result.success) {
                setCommitMessage('');
                setSuccessMessage('All changes committed successfully');
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
                onRefresh?.();
            } else {
                setError(result.stderr || result.message || 'Commit failed');
            }
        } catch (err) {
            setError('Failed to commit');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    // Discard changes for a file
    const discardFile = async (path: string) => {
        if (!confirm(`Discard changes to "${path}"? This cannot be undone.`)) {
            return;
        }

        try {
            await gitApi.exec(projectId, `checkout -- "${path}"`);
            await loadStatus();
            onRefresh?.();
        } catch (err) {
            setError('Failed to discard changes');
            console.error(err);
        }
    };

    // Discard all changes
    const discardAll = async () => {
        if (!confirm('Discard ALL changes? This cannot be undone.')) {
            return;
        }

        try {
            await gitApi.exec(projectId, 'checkout -- .');
            // Also clean untracked files
            await gitApi.exec(projectId, 'clean -fd');
            await loadStatus();
            onRefresh?.();
        } catch (err) {
            setError('Failed to discard changes');
            console.error(err);
        }
    };

    // Try operation without credentials first, then with if needed
    const handlePush = async () => {
        setLoading(true);
        try {
            const result = await gitApi.push(projectId);
            if (result.success) {
                setSuccessMessage('Pushed successfully');
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
                onRefresh?.();
            } else if (result.stderr?.includes('Authentication') || result.stderr?.includes('403') || result.stderr?.includes('401')) {
                setCredDialog({ isOpen: true, type: 'push' });
            } else {
                setError(result.message || result.stderr || 'Push failed');
            }
        } catch {
            setCredDialog({ isOpen: true, type: 'push' });
        } finally {
            setLoading(false);
        }
    };

    const handlePull = async () => {
        setLoading(true);
        try {
            const result = await gitApi.pull(projectId);
            if (result.success) {
                setSuccessMessage('Pulled successfully');
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
                onRefresh?.();
            } else {
                setCredDialog({ isOpen: true, type: 'pull' });
            }
        } catch {
            setCredDialog({ isOpen: true, type: 'pull' });
        } finally {
            setLoading(false);
        }
    };

    // Sync (pull then push)
    const handleSync = async () => {
        await handlePull();
        await handlePush();
    };

    // Execute push/pull with provided credentials
    const executePushPull = async (type: 'push' | 'pull', username?: string, token?: string) => {
        setLoading(true);
        setError(null);

        try {
            if (type === 'push') {
                const result = await gitApi.push(
                    projectId,
                    username,
                    token
                );
                if (result.success) {
                    setSuccessMessage('Pushed successfully');
                    setTimeout(() => setSuccessMessage(null), 3000);
                } else {
                    // Check if auth failed - show dialog with error
                    if (result.stderr?.includes('Authentication') || result.stderr?.includes('403') || result.stderr?.includes('401')) {
                        setCredDialog({ isOpen: true, type: 'push', error: 'Authentication failed. Please check your credentials.' });
                        return;
                    }
                    setError(result.message || 'Push failed');
                }
            } else {
                const result = await gitApi.pull(
                    projectId,
                    undefined,
                    username,
                    token
                );
                if (result.success) {
                    setSuccessMessage('Pulled successfully');
                    setTimeout(() => setSuccessMessage(null), 3000);
                } else {
                    setCredDialog({ isOpen: true, type: 'pull', error: 'Authentication failed.' });
                    return;
                }
            }
            await loadStatus();
            onRefresh?.();
        } catch (err) {
            setError(`${type} failed`);
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    // Handle credential dialog submit
    const handleCredentialSubmit = async (username: string, token: string, _rememberMe: boolean) => {
        const type = credDialog.type;
        setCredDialog({ isOpen: false, type: 'push' });

        await executePushPull(type as 'push' | 'pull', username, token);
    };

    const cancelCredDialog = () => {
        setCredDialog({ isOpen: false, type: 'push' });
    };

    const handleCreateBranch = async () => {
        if (!newBranchName.trim()) {
            setError('Please enter a branch name');
            return;
        }

        setBranchLoading(true);
        setError(null);
        try {
            const result = await gitApi.checkout(projectId, newBranchName.trim(), true);
            if (result.success) {
                setCurrentBranch(newBranchName.trim());
                setNewBranchName('');
                setShowNewBranch(false);
                setSuccessMessage(`Created and switched to branch '${newBranchName.trim()}'`);
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
            } else {
                setError(result.message || 'Failed to create branch');
            }
        } catch (err) {
            setError('Failed to create branch');
            console.error(err);
        } finally {
            setBranchLoading(false);
        }
    };

    const handleSwitchBranch = async (branch: GitBranchInfo) => {
        if (branch.is_current) return;

        setBranchLoading(true);
        setError(null);
        setSuccessMessage(null);

        try {
            let result: { success: boolean; message?: string; stderr?: string };
            if (branch.is_remote) {
                const localBranchName = branch.name.replace(/^[^/]+\//, '');
                const hasLocalBranch = branches.some((b) => !b.is_remote && b.name === localBranchName);
                result = hasLocalBranch
                    ? await gitApi.checkout(projectId, localBranchName)
                    : await gitApi.exec(projectId, `checkout --track ${branch.name}`);
            } else {
                result = await gitApi.checkout(projectId, branch.name);
            }

            if (result.success) {
                setSuccessMessage(`Switched to branch '${branch.is_remote ? branch.name.replace(/^[^/]+\//, '') : branch.name}'`);
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
                onRefresh?.();
            } else {
                setError(result.message || result.stderr || 'Failed to switch branch');
            }
        } catch (err) {
            setError('Failed to switch branch');
            console.error(err);
        } finally {
            setBranchLoading(false);
        }
    };

    const handleSaveRemote = async () => {
        if (!remoteNameInput.trim()) {
            setError('Please enter a remote name');
            return;
        }
        if (!remoteUrlInput.trim()) {
            setError('Please enter a remote URL');
            return;
        }

        setRemoteLoading(true);
        setError(null);
        setSuccessMessage(null);

        try {
            const result = await gitApi.addRemote(projectId, remoteNameInput.trim(), remoteUrlInput.trim());
            if (result.success) {
                setRemoteUrl(remoteUrlInput.trim());
                setShowRemoteSettings(false);
                setSuccessMessage(result.message || 'Remote updated');
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
            } else {
                setError(result.message || 'Failed to update remote');
            }
        } catch (err) {
            setError('Failed to update remote');
            console.error(err);
        } finally {
            setRemoteLoading(false);
        }
    };

    const handleFetch = async () => {
        setLoading(true);
        setError(null);
        setSuccessMessage(null);
        try {
            const result = await gitApi.fetch(projectId);
            if (result.success) {
                setSuccessMessage('Fetched remote updates');
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
            } else {
                setError(result.message || 'Fetch failed');
            }
        } catch (err) {
            const message = err && typeof err === 'object' && 'message' in err
                ? String((err as { message?: unknown }).message)
                : '';
            if (message.includes('could not read Username') || message.includes('Authentication')) {
                setCredDialog({ isOpen: true, type: 'pull', error: 'Authentication failed. Please check your credentials.' });
            } else {
                setError('Fetch failed');
            }
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const totalChanges = stagedChanges.length + unstagedChanges.length;
    const changedFiles = [...stagedChanges, ...unstagedChanges].reduce<FileChange[]>((files, file) => {
        const existing = files.find((item) => item.path === file.path);
        if (existing) {
            existing.status = file.status;
            existing.staged = existing.staged || file.staged;
            return files;
        }
        files.push({ ...file });
        return files;
    }, []);
    const localBranches = branches.filter((branch) => !branch.is_remote);
    const remoteBranches = branches.filter((branch) => branch.is_remote);

    const handleGitInit = async () => {
        setInitLoading(true);
        setError(null);
        try {
            const result = await gitApi.init(projectId);
            if (result.success) {
                setIsNoRepo(false);
                setSuccessMessage('Repository initialized');
                setTimeout(() => setSuccessMessage(null), 3000);
                await loadStatus();
            } else {
                setError('Failed to initialize repository');
            }
        } catch {
            setError('Failed to initialize repository');
        } finally {
            setInitLoading(false);
        }
    };

    return (
        <div className="h-full flex flex-col bg-white text-[#242424]">
            {/* No git repo state */}
            {isNoRepo && (
                <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
                    <GitBranch className="w-8 h-8 text-[#A0A0A0]" />
                    <div>
                        <p className="text-sm font-medium text-[#242424]">No Git repository</p>
                        <p className="text-xs text-[#616161] mt-0.5">This project is not initialized as a Git repository.</p>
                    </div>
                    {error && (
                        <p className="text-xs text-[#DC2626]">{error}</p>
                    )}
                    <button
                        onClick={handleGitInit}
                        disabled={initLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0078D4] hover:bg-[#106EBE] disabled:opacity-50 rounded text-xs font-medium text-white"
                    >
                        {initLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Initialize Repository
                    </button>
                </div>
            )}

            {/* Credential Dialog - Using new unified component */}
            <GitCredentialDialog
                isOpen={credDialog.isOpen}
                operationType={credDialog.type}
                remoteUrl={remoteUrl}
                error={credDialog.error}
                onSubmit={handleCredentialSubmit}
                onCancel={cancelCredDialog}
            />

            {!isNoRepo && <>
            {/* Header */}
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#E6E6E6] bg-[#FAF9F8]">
                <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-[#0078D4]" />
                    <span className="text-xs font-medium text-[#616161] uppercase tracking-wide">
                        Source Control
                    </span>
                    {changedFiles.length > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] bg-[#0078D4] text-white rounded-full">
                            {changedFiles.length}
                        </span>
                    )}
                </div>
                <button
                    onClick={loadStatus}
                    disabled={refreshing}
                    className="p-1 hover:bg-[#E6E6E6] rounded text-[#616161] hover:text-[#242424]"
                    title="Refresh"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Messages */}
            {error && (
                <div className="mx-2 mt-2 p-2 bg-[#FEE2E2] border border-[#FECACA] rounded text-[#DC2626] text-xs flex items-center justify-between">
                    <span>{error}</span>
                    <button onClick={() => setError(null)}>
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}
            {successMessage && (
                <div className="mx-2 mt-2 p-2 bg-[#D1FAE5] border border-[#A7F3D0] rounded text-[#047857] text-xs flex items-center gap-2">
                    <Check className="w-3 h-3" />
                    <span>{successMessage}</span>
                </div>
            )}

            {/* Simple Commit Flow */}
            <div className="p-2 border-b border-[#E6E6E6] space-y-2">
                <div className="flex items-center justify-between gap-2 rounded bg-[#F3F2F1] px-2 py-1.5 text-xs">
                    <div className="min-w-0 flex items-center gap-1.5 text-[#616161]">
                        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#0078D4]" />
                        <span className="truncate font-medium text-[#242424]" title={currentBranch}>{currentBranch}</span>
                    </div>
                    <div className="shrink-0 text-[#616161]">
                        {changedFiles.length === 0 ? 'No changes' : `${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed`}
                    </div>
                </div>
                {(syncStatus.ahead > 0 || syncStatus.behind > 0) && (
                    <div className="flex items-center justify-between rounded bg-[#EFF6FF] px-2 py-1.5 text-xs text-[#1D4ED8]">
                        <div className="flex items-center gap-1.5">
                            <ArrowUpDown className="h-3 w-3" />
                            <span>
                                {syncStatus.ahead > 0 && `${syncStatus.ahead} to push`}
                                {syncStatus.ahead > 0 && syncStatus.behind > 0 && ', '}
                                {syncStatus.behind > 0 && `${syncStatus.behind} to pull`}
                            </span>
                        </div>
                        <button onClick={handleSync} disabled={loading} className="font-medium hover:underline">
                            Sync
                        </button>
                    </div>
                )}
                <textarea
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    placeholder="Describe what changed"
                    className="w-full h-14 px-2 py-1.5 bg-[#FAF9F8] border border-[#E6E6E6] rounded text-sm resize-none focus:outline-none focus:border-[#0078D4] placeholder:text-[#A0A0A0]"
                    onKeyDown={(e) => {
                        if (e.ctrlKey && e.key === 'Enter') {
                            handleCommit();
                        }
                    }}
                />
                <div className="flex gap-1.5 mt-1.5">
                    <button
                        onClick={handleCommit}
                        disabled={loading || !commitMessage.trim() || totalChanges === 0}
                        className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-[#0078D4] hover:bg-[#106EBE] disabled:opacity-50 disabled:cursor-not-allowed rounded text-xs font-medium text-white"
                        title="Commit all changed files"
                    >
                        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Commit changes
                    </button>
                    <button
                        onClick={handlePush}
                        disabled={loading}
                        className="p-1.5 bg-[#F3F2F1] hover:bg-[#E6E6E6] rounded text-[#616161]"
                        title="Push"
                    >
                        <Upload className="w-3.5 h-3.5" />
                    </button>
                    <button
                        onClick={handlePull}
                        disabled={loading}
                        className="p-1.5 bg-[#F3F2F1] hover:bg-[#E6E6E6] rounded text-[#616161]"
                        title="Pull"
                    >
                        <Download className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* Changes List */}
            <div className="flex-1 overflow-y-auto text-sm">
                <div className="border-b border-[#E6E6E6] px-2 py-1.5">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[#616161]">Changed files</span>
                        {changedFiles.length > 0 && (
                            <span className="text-xs text-[#A0A0A0]">{changedFiles.length}</span>
                        )}
                    </div>
                </div>
                {changedFiles.length > 0 && (
                    <div className="pb-1">
                        {changedFiles.map((file) => {
                            const statusDisplay = getStatusDisplay(file.status);
                            return (
                                <button
                                    type="button"
                                    key={`changed-${file.path}`}
                                    onClick={() => onOpenDiff?.(file.path)}
                                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-[#F3F2F1]"
                                    title="Open diff"
                                >
                                    <FileText className="w-3.5 h-3.5 shrink-0 text-[#616161]" />
                                    <span className="min-w-0 flex-1 truncate text-xs" title={file.path}>
                                        {file.path}
                                    </span>
                                    <span
                                        className={`w-4 h-4 shrink-0 flex items-center justify-center text-[10px] font-bold rounded ${statusDisplay.color} ${statusDisplay.bgColor}`}
                                        title={statusDisplay.label}
                                    >
                                        {statusDisplay.letter}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Empty State */}
                {totalChanges === 0 && !refreshing && (
                    <div className="flex flex-col items-center justify-center py-6 text-[#616161]">
                        <Check className="w-6 h-6 mb-2 text-[#047857]" />
                        <span className="text-xs">No changes</span>
                        <span className="text-[10px] text-[#A0A0A0] mt-0.5">Working tree clean</span>
                    </div>
                )}

                {/* Advanced Git Controls */}
                <div className="border-t border-[#E6E6E6]">
                    <button
                        type="button"
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className="flex w-full items-center justify-between px-2 py-1.5 text-xs font-medium text-[#616161] hover:bg-[#F3F2F1]"
                    >
                        <span>Advanced</span>
                        {showAdvanced ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                        )}
                    </button>
                    {showAdvanced && (
                        <div className="border-t border-[#F3F2F1]">
                            {/* Repository Settings */}
                            <div className="px-2 py-2 border-b border-[#E6E6E6] space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0 flex items-center gap-2 text-xs">
                                        <GitBranch className="w-3.5 h-3.5 shrink-0 text-[#0078D4]" />
                                        <span className="text-[#616161]">Branch</span>
                                        <span className="truncate text-[#242424] font-medium" title={currentBranch}>{currentBranch}</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => setShowNewBranch(true)}
                                            disabled={branchLoading}
                                            className="p-1 text-[#0078D4] hover:bg-[#E6E6E6] disabled:opacity-50 rounded"
                                            title="Create new branch"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={handleFetch}
                                            disabled={loading}
                                            className="p-1 text-[#616161] hover:bg-[#E6E6E6] disabled:opacity-50 rounded"
                                            title="Fetch remotes"
                                        >
                                            <RefreshCw className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                                <select
                                    value={currentBranch}
                                    disabled={branchLoading || branches.length === 0}
                                    onChange={(e) => {
                                        const branch = branches.find((item) => item.name === e.target.value);
                                        if (branch) handleSwitchBranch(branch);
                                    }}
                                    className="w-full px-2 py-1 bg-[#FAF9F8] border border-[#E6E6E6] rounded text-xs focus:outline-none focus:border-[#0078D4] disabled:opacity-60"
                                    title="Switch branch"
                                >
                                    {localBranches.length > 0 && (
                                        <optgroup label="Local branches">
                                            {localBranches.map((branch) => (
                                                <option key={branch.name} value={branch.name}>
                                                    {branch.name}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                    {remoteBranches.length > 0 && (
                                        <optgroup label="Remote branches">
                                            {remoteBranches.map((branch) => (
                                                <option key={branch.name} value={branch.name}>
                                                    {branch.name}
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                </select>
                                {showNewBranch && (
                                    <div className="flex items-center gap-1 mt-1">
                                        <input
                                            type="text"
                                            value={newBranchName}
                                            onChange={(e) => setNewBranchName(e.target.value)}
                                            placeholder="new-branch-name"
                                            className="flex-1 px-2 py-1 bg-[#FAF9F8] border border-[#E6E6E6] rounded text-xs focus:outline-none focus:border-[#0078D4]"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleCreateBranch();
                                                if (e.key === 'Escape') { setShowNewBranch(false); setNewBranchName(''); }
                                            }}
                                            autoFocus
                                        />
                                        <button
                                            onClick={handleCreateBranch}
                                            disabled={branchLoading || !newBranchName.trim()}
                                            className="px-2 py-1 bg-[#0078D4] hover:bg-[#106EBE] disabled:opacity-50 rounded text-xs text-white"
                                        >
                                            {branchLoading ? '...' : 'Create'}
                                        </button>
                                        <button
                                            onClick={() => { setShowNewBranch(false); setNewBranchName(''); }}
                                            className="p-1 hover:bg-[#E6E6E6] rounded text-[#616161]"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                )}
                                <div className="pt-1 border-t border-[#F3F2F1]">
                                    <div className="flex items-center justify-between gap-2 text-xs">
                                        <span className="shrink-0 text-[#616161]">Remote</span>
                                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#242424]" title={remoteUrl || 'No remote configured'}>
                                            {remoteUrl || 'No remote configured'}
                                        </span>
                                        <button
                                            onClick={() => setShowRemoteSettings(!showRemoteSettings)}
                                            className="shrink-0 px-1.5 py-0.5 rounded text-[#0078D4] hover:bg-[#E6E6E6]"
                                        >
                                            {showRemoteSettings ? 'Close' : 'Edit'}
                                        </button>
                                    </div>
                                    {remotes.length > 1 && (
                                        <div className="mt-1 space-y-0.5">
                                            {remotes.map((remote) => (
                                                <div key={remote.name} className="flex items-center gap-2 text-[11px] text-[#616161]">
                                                    <span className="w-12 shrink-0 font-medium">{remote.name}</span>
                                                    <span className="truncate font-mono" title={remote.fetch_url || remote.push_url}>
                                                        {remote.fetch_url || remote.push_url}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {showRemoteSettings && (
                                        <div className="mt-2 space-y-1">
                                            <input
                                                type="text"
                                                value={remoteNameInput}
                                                onChange={(e) => setRemoteNameInput(e.target.value)}
                                                placeholder="origin"
                                                className="w-full px-2 py-1 bg-[#FAF9F8] border border-[#E6E6E6] rounded text-xs focus:outline-none focus:border-[#0078D4]"
                                            />
                                            <input
                                                type="text"
                                                value={remoteUrlInput}
                                                onChange={(e) => setRemoteUrlInput(e.target.value)}
                                                placeholder="https://github.com/user/repo.git"
                                                className="w-full px-2 py-1 bg-[#FAF9F8] border border-[#E6E6E6] rounded text-xs focus:outline-none focus:border-[#0078D4]"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleSaveRemote();
                                                    if (e.key === 'Escape') setShowRemoteSettings(false);
                                                }}
                                            />
                                            <button
                                                onClick={handleSaveRemote}
                                                disabled={remoteLoading || !remoteNameInput.trim() || !remoteUrlInput.trim()}
                                                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 bg-[#0078D4] hover:bg-[#106EBE] disabled:opacity-50 rounded text-xs font-medium text-white"
                                            >
                                                {remoteLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                                                Save Remote
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Staged Changes */}
                            <div className="border-b border-[#E6E6E6]">
                    <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedStaged(!expandedStaged)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedStaged(!expandedStaged); }}
                        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-[#F3F2F1] cursor-pointer"
                    >
                        <div className="flex items-center gap-1.5">
                            {expandedStaged ? (
                                <ChevronDown className="w-3.5 h-3.5 text-[#616161]" />
                            ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-[#616161]" />
                            )}
                            <span className="text-xs font-medium text-[#616161]">
                                Staged Changes
                            </span>
                            <span className="text-xs text-[#A0A0A0]">
                                ({stagedChanges.length})
                            </span>
                        </div>
                        {stagedChanges.length > 0 && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    unstageAll();
                                }}
                                className="p-0.5 hover:bg-[#E6E6E6] rounded text-[#616161]"
                                title="Unstage All"
                            >
                                <Minus className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                    {expandedStaged && stagedChanges.length > 0 && (
                        <div className="pb-1">
                            {stagedChanges.map((file) => {
                                const statusDisplay = getStatusDisplay(file.status);
                                return (
                                    <div
                                        key={`staged-${file.path}`}
                                        className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#F3F2F1] group"
                                    >
                                        <FileText className="w-3.5 h-3.5 text-[#616161]" />
                                        <span className="flex-1 truncate text-xs" title={file.path}>
                                            {file.path}
                                        </span>
                                        <span
                                            className={`w-4 h-4 flex items-center justify-center text-[10px] font-bold rounded ${statusDisplay.color} ${statusDisplay.bgColor}`}
                                            title={statusDisplay.label}
                                        >
                                            {statusDisplay.letter}
                                        </span>
                                        <button
                                            onClick={() => unstageFile(file.path)}
                                            className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[#E6E6E6] rounded text-[#616161]"
                                            title="Unstage"
                                        >
                                            <Minus className="w-3 h-3" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Unstaged Changes */}
                <div>
                    <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setExpandedChanges(!expandedChanges)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedChanges(!expandedChanges); }}
                        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-[#F3F2F1] cursor-pointer"
                    >
                        <div className="flex items-center gap-1.5">
                            {expandedChanges ? (
                                <ChevronDown className="w-3.5 h-3.5 text-[#616161]" />
                            ) : (
                                <ChevronRight className="w-3.5 h-3.5 text-[#616161]" />
                            )}
                            <span className="text-xs font-medium text-[#616161]">
                                Changes
                            </span>
                            <span className="text-xs text-[#A0A0A0]">
                                ({unstagedChanges.length})
                            </span>
                        </div>
                        {unstagedChanges.length > 0 && (
                            <div className="flex items-center gap-0.5">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        discardAll();
                                    }}
                                    className="p-0.5 hover:bg-[#E6E6E6] rounded text-[#616161]"
                                    title="Discard All Changes"
                                >
                                    <RotateCcw className="w-3 h-3" />
                                </button>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        stageAll();
                                    }}
                                    className="p-0.5 hover:bg-[#E6E6E6] rounded text-[#616161]"
                                    title="Stage All"
                                >
                                    <Plus className="w-3 h-3" />
                                </button>
                            </div>
                        )}
                    </div>
                    {expandedChanges && unstagedChanges.length > 0 && (
                        <div className="pb-1">
                            {unstagedChanges.map((file) => {
                                const statusDisplay = getStatusDisplay(file.status);
                                return (
                                    <div
                                        key={`unstaged-${file.path}`}
                                        className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#F3F2F1] group"
                                    >
                                        <FileText className="w-3.5 h-3.5 text-[#616161]" />
                                        <span className="flex-1 truncate text-xs" title={file.path}>
                                            {file.path}
                                        </span>
                                        <span
                                            className={`w-4 h-4 flex items-center justify-center text-[10px] font-bold rounded ${statusDisplay.color} ${statusDisplay.bgColor}`}
                                            title={statusDisplay.label}
                                        >
                                            {statusDisplay.letter}
                                        </span>
                                        <button
                                            onClick={() => discardFile(file.path)}
                                            className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[#E6E6E6] rounded text-[#616161]"
                                            title="Discard Changes"
                                        >
                                            <RotateCcw className="w-3 h-3" />
                                        </button>
                                        <button
                                            onClick={() => stageFile(file.path)}
                                            className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[#E6E6E6] rounded text-[#616161]"
                                            title="Stage"
                                        >
                                            <Plus className="w-3 h-3" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                        </div>
                    )}
                </div>
            </div>
            </>}
        </div>
    );
}
