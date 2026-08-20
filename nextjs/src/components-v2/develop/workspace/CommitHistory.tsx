'use client';

/**
 * CommitHistory - Git commit timeline
 * Matches app's Fluent UI light theme
 */

import React, { useState, useEffect, useCallback } from 'react';
import { History, RefreshCw, GitCommit, User, Clock } from 'lucide-react';
import { gitApi, type GitCommitInfo } from '@/lib/api';

interface CommitHistoryProps {
    projectId: string;
}

export default function CommitHistory({ projectId }: CommitHistoryProps) {
    const [commits, setCommits] = useState<GitCommitInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedCommit, setSelectedCommit] = useState<string | null>(null);

    const loadCommits = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await gitApi.getLog(projectId, 50);
            if (data.success) {
                setCommits(data.commits);
            } else {
                setError('Failed to load commits');
            }
        } catch (err) {
            setError('Failed to load commit history');
            console.error(err);
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        loadCommits();
    }, [loadCommits]);

    // Format relative time
    const formatRelativeTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    };

    // Truncate commit hash
    const shortHash = (hash: string) => hash.substring(0, 7);

    return (
        <div className="h-full flex flex-col bg-white text-[#242424]">
            {/* Header */}
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#E6E6E6] bg-[#FAF9F8]">
                <div className="flex items-center gap-2">
                    <History className="w-4 h-4 text-[#0078D4]" />
                    <span className="text-xs font-medium text-[#616161] uppercase tracking-wide">
                        Commits
                    </span>
                    {commits.length > 0 && (
                        <span className="text-xs text-[#A0A0A0]">({commits.length})</span>
                    )}
                </div>
                <button
                    onClick={loadCommits}
                    disabled={loading}
                    className="p-1 hover:bg-[#E6E6E6] rounded text-[#616161] hover:text-[#242424]"
                    title="Refresh"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Error */}
            {error && (
                <div className="mx-2 mt-2 p-2 bg-[#FEE2E2] border border-[#FECACA] rounded text-[#DC2626] text-xs">
                    {error}
                </div>
            )}

            {/* Commit List */}
            <div className="flex-1 overflow-y-auto">
                {commits.map((commit, index) => (
                    <div
                        key={commit.hash}
                        className={`relative flex gap-2 px-2 py-2 hover:bg-[#F3F2F1] cursor-pointer border-b border-[#F3F2F1] ${selectedCommit === commit.hash ? 'bg-[#E6E6E6]' : ''
                            }`}
                        onClick={() => setSelectedCommit(
                            selectedCommit === commit.hash ? null : commit.hash
                        )}
                    >
                        {/* Timeline connector */}
                        <div className="flex flex-col items-center pt-0.5">
                            <div className="w-2.5 h-2.5 rounded-full bg-[#0078D4] border-2 border-white z-10" />
                            {index < commits.length - 1 && (
                                <div className="w-0.5 flex-1 bg-[#E6E6E6] -mb-2" />
                            )}
                        </div>

                        {/* Commit info */}
                        <div className="flex-1 min-w-0">
                            <p className="text-xs text-[#242424] line-clamp-2 leading-tight">
                                {commit.message}
                            </p>

                            <div className="flex items-center gap-2 mt-1 text-[10px] text-[#616161]">
                                <span className="flex items-center gap-0.5">
                                    <GitCommit className="w-2.5 h-2.5" />
                                    <code className="text-[#0078D4] font-mono">{shortHash(commit.hash)}</code>
                                </span>
                                <span className="flex items-center gap-0.5">
                                    <User className="w-2.5 h-2.5" />
                                    {commit.author}
                                </span>
                                <span className="flex items-center gap-0.5">
                                    <Clock className="w-2.5 h-2.5" />
                                    {formatRelativeTime(commit.date)}
                                </span>
                            </div>

                            {/* Expanded details */}
                            {selectedCommit === commit.hash && (
                                <div className="mt-2 p-2 bg-[#FAF9F8] rounded border border-[#E6E6E6] text-[10px]">
                                    <div className="grid grid-cols-[60px_1fr] gap-1 text-[#616161]">
                                        <span>Hash:</span>
                                        <code className="text-[#242424] font-mono text-[9px]">{commit.hash}</code>
                                        <span>Author:</span>
                                        <span className="text-[#242424]">{commit.author} &lt;{commit.email}&gt;</span>
                                        <span>Date:</span>
                                        <span className="text-[#242424]">{new Date(commit.date).toLocaleString()}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                ))}

                {/* Empty State */}
                {commits.length === 0 && !loading && (
                    <div className="flex flex-col items-center justify-center py-6 text-[#616161]">
                        <GitCommit className="w-6 h-6 mb-2" />
                        <span className="text-xs">No commits yet</span>
                    </div>
                )}

                {/* Loading State */}
                {loading && commits.length === 0 && (
                    <div className="flex items-center justify-center py-6 text-[#616161]">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                    </div>
                )}
            </div>
        </div>
    );
}
