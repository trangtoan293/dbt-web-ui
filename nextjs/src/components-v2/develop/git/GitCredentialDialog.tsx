'use client';

/**
 * GitCredentialDialog - Unified credential dialog for Git operations
 * 
 * Features:
 * - Single dialog for all git auth operations (push, pull, clone, fetch)
 * - Clear error messages
 */

import React, { useState, useEffect } from 'react';
import { Key, X, Eye, EyeOff, AlertCircle } from 'lucide-react';

export type GitOperationType = 'push' | 'pull' | 'clone' | 'fetch';

export interface GitCredentialDialogProps {
    isOpen: boolean;
    operationType: GitOperationType;
    remoteUrl?: string;
    error?: string | null;
    onSubmit: (username: string, token: string, rememberMe: boolean) => void;
    onCancel: () => void;
    onSkip?: () => void; // For operations that might work without auth (public repos)
}

const operationLabels: Record<GitOperationType, string> = {
    push: 'Push',
    pull: 'Pull',
    clone: 'Clone',
    fetch: 'Fetch',
};

const operationDescriptions: Record<GitOperationType, string> = {
    push: 'Enter credentials to push changes to remote repository',
    pull: 'Enter credentials to pull changes from remote repository',
    clone: 'Enter credentials to clone the repository',
    fetch: 'Enter credentials to fetch updates from remote',
};

export default function GitCredentialDialog({
    isOpen,
    operationType,
    remoteUrl,
    error,
    onSubmit,
    onCancel,
    onSkip,
}: GitCredentialDialogProps) {
    const [username, setUsername] = useState('');
    const [token, setToken] = useState('');
    const [showToken, setShowToken] = useState(false);

    // Reset form when dialog opens. Remembered credentials live encrypted on the server.
    useEffect(() => {
        if (isOpen) {
            setUsername('');
            setToken('');
        }
    }, [isOpen, remoteUrl]);

    // Reset state when dialog closes
    useEffect(() => {
        if (!isOpen) {
            setShowToken(false);
        }
    }, [isOpen]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        
        onSubmit(username, token, false);
    };

    if (!isOpen) return null;

    return (
        <div 
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            onClick={onCancel}
        >
            <div 
                className="bg-white rounded-lg shadow-xl w-96 max-w-[90vw]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-[#E6E6E6]">
                    <div className="flex items-center gap-2">
                        <Key className="w-5 h-5 text-[#0078D4]" />
                        <span className="font-semibold text-[#242424]">
                            Git Authentication
                        </span>
                    </div>
                    <button 
                        onClick={onCancel}
                        className="p-1 hover:bg-[#F3F2F1] rounded text-[#616161] hover:text-[#242424]"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Content */}
                <form onSubmit={handleSubmit} className="p-4">
                    <p className="text-sm text-[#616161] mb-4">
                        {operationDescriptions[operationType]}
                    </p>

                    {/* Error message */}
                    {error && (
                        <div className="mb-4 p-3 bg-[#FEE2E2] border border-[#FECACA] rounded-md flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 text-[#DC2626] mt-0.5 flex-shrink-0" />
                            <span className="text-sm text-[#DC2626]">{error}</span>
                        </div>
                    )}

                    {/* Remote URL display */}
                    {remoteUrl && (
                        <div className="mb-4 p-2 bg-[#F3F2F1] rounded text-xs text-[#616161] break-all">
                            <span className="font-medium">Remote:</span> {remoteUrl.replace(/\/\/[^:]+:[^@]+@/, '//')}
                        </div>
                    )}

                    {/* Username field */}
                    <div className="mb-3">
                        <label className="block text-sm font-medium text-[#242424] mb-1">
                            Username
                        </label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="your-username"
                            className="w-full px-3 py-2 bg-[#FAF9F8] border border-[#E6E6E6] rounded-md text-sm focus:outline-none focus:border-[#0078D4] focus:ring-1 focus:ring-[#0078D4]"
                            autoFocus
                            autoComplete="username"
                        />
                    </div>

                    {/* Token/Password field */}
                    <div className="mb-4">
                        <label className="block text-sm font-medium text-[#242424] mb-1">
                            Token / Password
                        </label>
                        <div className="relative">
                            <input
                                type={showToken ? 'text' : 'password'}
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                                placeholder="••••••••••••"
                                className="w-full px-3 py-2 pr-10 bg-[#FAF9F8] border border-[#E6E6E6] rounded-md text-sm focus:outline-none focus:border-[#0078D4] focus:ring-1 focus:ring-[#0078D4]"
                                autoComplete="current-password"
                            />
                            <button
                                type="button"
                                onClick={() => setShowToken(!showToken)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#616161] hover:text-[#242424]"
                            >
                                {showToken ? (
                                    <EyeOff className="w-4 h-4" />
                                ) : (
                                    <Eye className="w-4 h-4" />
                                )}
                            </button>
                        </div>
                        <p className="mt-1 text-xs text-[#616161]">
                            For GitHub, use a Personal Access Token (PAT)
                        </p>
                    </div>

                    <div className="mb-4 text-xs text-[#616161]">
                        Credentials are cleared when you close the browser.
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="flex-1 px-4 py-2 bg-[#F3F2F1] hover:bg-[#E6E6E6] rounded-md text-sm font-medium text-[#242424]"
                        >
                            Cancel
                        </button>
                        {onSkip && (
                            <button
                                type="button"
                                onClick={onSkip}
                                className="px-4 py-2 bg-[#F3F2F1] hover:bg-[#E6E6E6] rounded-md text-sm text-[#616161]"
                            >
                                Skip
                            </button>
                        )}
                        <button
                            type="submit"
                            className="flex-1 px-4 py-2 bg-[#0078D4] hover:bg-[#106EBE] rounded-md text-sm font-medium text-white"
                        >
                            {operationLabels[operationType]}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
