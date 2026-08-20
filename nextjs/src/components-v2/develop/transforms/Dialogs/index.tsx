'use client';

/**
 * Dialogs - Modal components for various actions
 * EXACT COPY from page.tsx lines 1686-1920 (preserving format and UI)
 */

import React from 'react';
import Link from 'next/link';
import { X, Key, GitBranch, Save, Upload, Database, CheckCircle, FileText } from 'lucide-react';
import type { Connection } from '@/components-v2/develop/types';

// ==================== NEW FILE DIALOG ====================
interface NewFileDialogProps {
    isOpen: boolean;
    type: 'file' | 'directory';
    fileName: string;
    onFileNameChange: (name: string) => void;
    onClose: () => void;
    onCreate: () => void;
}

export function NewFileDialog({
    isOpen,
    type,
    fileName,
    onFileNameChange,
    onClose,
    onCreate,
}: NewFileDialogProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white rounded-lg p-4 w-96" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-medium mb-4">
                    {type === 'file' ? 'New File' : 'New Folder'}
                </h3>
                <input
                    type="text"
                    value={fileName}
                    onChange={(e) => onFileNameChange(e.target.value)}
                    placeholder={type === 'file' ? 'filename.sql' : 'folder_name'}
                    className="w-full px-3 py-2 border border-[#E6E6E6] rounded mb-4"
                    autoFocus
                />
                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded">Cancel</button>
                    <button onClick={onCreate} className="px-3 py-1.5 text-sm bg-[#0078D4] text-white rounded">Create</button>
                </div>
            </div>
        </div>
    );
}

// ==================== RENAME DIALOG ====================
interface RenameDialogProps {
    isOpen: boolean;
    type: 'file' | 'directory';
    renameName: string;
    onRenameChange: (name: string) => void;
    onClose: () => void;
    onRename: () => void;
}

export function RenameDialog({
    isOpen,
    type,
    renameName,
    onRenameChange,
    onClose,
    onRename,
}: RenameDialogProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white rounded-lg p-4 w-96" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-medium mb-4">
                    Rename {type === 'file' ? 'File' : 'Folder'}
                </h3>
                <input
                    type="text"
                    value={renameName}
                    onChange={(e) => onRenameChange(e.target.value)}
                    placeholder="New name"
                    className="w-full px-3 py-2 border border-[#E6E6E6] rounded mb-4"
                    autoFocus
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') onRename();
                        if (e.key === 'Escape') onClose();
                    }}
                />
                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded">Cancel</button>
                    <button onClick={onRename} className="px-3 py-1.5 text-sm bg-[#0078D4] text-white rounded">Rename</button>
                </div>
            </div>
        </div>
    );
}

// ==================== GIT CREDENTIAL DIALOG ====================
interface GitCredDialogProps {
    isOpen: boolean;
    type: 'push' | 'pull';
    username: string;
    token: string;
    onUsernameChange: (value: string) => void;
    onTokenChange: (value: string) => void;
    onCancel: () => void;
    onSubmit: () => void;
}

export function GitCredDialog({
    isOpen,
    type,
    username,
    token,
    onUsernameChange,
    onTokenChange,
    onCancel,
    onSubmit,
}: GitCredDialogProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onCancel}>
            <div className="bg-white rounded-lg p-5 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                        <Key className="w-5 h-5 text-yellow-500" />
                        Git Credentials
                    </h3>
                    <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <p className="text-sm text-gray-500 mb-4">
                    Enter credentials for HTTPS authentication
                </p>
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => onUsernameChange(e.target.value)}
                            placeholder="your-username"
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Token / Password</label>
                        <input
                            type="password"
                            value={token}
                            onChange={(e) => onTokenChange(e.target.value)}
                            placeholder="••••••••••••"
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                            onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                        />
                    </div>
                </div>
                <div className="flex gap-3 mt-5">
                    <button
                        onClick={onCancel}
                        className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onSubmit}
                        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
                    >
                        {type === 'push' ? 'Push' : 'Pull'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ==================== GIT PANEL MODAL ====================
interface GitPanelModalProps {
    isOpen: boolean;
    gitStatus: { clean: boolean; changes: { status: string; path: string }[] };
    commitMessage: string;
    onCommitMessageChange: (value: string) => void;
    onClose: () => void;
    onCommit: () => void;
    onPush: () => void;
}

export function GitPanelModal({
    isOpen,
    gitStatus,
    commitMessage,
    onCommitMessageChange,
    onClose,
    onCommit,
    onPush,
}: GitPanelModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white rounded-lg w-[480px]" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b">
                    <h3 className="text-lg font-medium flex items-center gap-2">
                        <GitBranch className="h-5 w-5" /> Git Sync
                    </h3>
                    <button onClick={onClose}><X className="h-5 w-5" /></button>
                </div>
                <div className="p-4">
                    <div className="mb-4">
                        <p className="text-sm text-[#616161] mb-2 flex items-center gap-1.5">
                            {gitStatus.clean ? (
                                <><CheckCircle className="h-4 w-4 text-[#038387]" /> No changes</>
                            ) : (
                                <><FileText className="h-4 w-4 text-[#B7791F]" /> {gitStatus.changes.length} file(s) changed</>
                            )}
                        </p>
                        {gitStatus.changes.length > 0 && (
                            <div className="max-h-32 overflow-auto text-xs bg-[#F3F2F1] p-2 rounded">
                                {gitStatus.changes.map((c, i) => (
                                    <div key={i}>{c.status} {c.path}</div>
                                ))}
                            </div>
                        )}
                    </div>
                    <textarea
                        value={commitMessage}
                        onChange={(e) => onCommitMessageChange(e.target.value)}
                        placeholder="Commit message..."
                        className="w-full px-3 py-2 border border-[#E6E6E6] rounded mb-4 h-20 resize-none"
                    />
                    <div className="flex gap-2">
                        <button onClick={onCommit} className="flex-1 px-3 py-2 bg-[#038387] text-white rounded flex items-center justify-center gap-2">
                            <Save className="h-4 w-4" /> Commit
                        </button>
                        <button onClick={onPush} className="flex-1 px-3 py-2 bg-[#0078D4] text-white rounded flex items-center justify-center gap-2">
                            <Upload className="h-4 w-4" /> Push
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ==================== CONNECTION SELECTOR MODAL ====================
interface ConnectionSelectorModalProps {
    isOpen: boolean;
    connections: Connection[];
    selectedConnectionId: string | null;
    actions?: React.ReactNode;
    onSelectConnection: (id: string) => void;
    onClose: () => void;
}

export function ConnectionSelectorModal({
    isOpen,
    connections,
    selectedConnectionId,
    actions,
    onSelectConnection,
    onClose,
}: ConnectionSelectorModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg w-full max-w-lg shadow-xl">
                <div className="px-6 py-4 border-b border-[#E6E6E6] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Database className="h-5 w-5 text-[#038387]" />
                        <h2 className="text-lg font-semibold text-[#242424]">Select Connection</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-[#616161] hover:text-[#242424]"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="p-6">
                    <p className="text-sm text-[#616161] mb-4">
                        Choose a database connection for this project. The connection will be used for running dbt commands.
                    </p>
                    {connections.length === 0 ? (
                        <div className="text-center py-8">
                            <Database className="h-12 w-12 text-[#D1D1D1] mx-auto mb-3" />
                            <p className="text-sm text-[#616161] mb-4">No connections available</p>
                            <Link
                                href="/connections"
                                className="inline-flex items-center gap-2 px-4 py-2 bg-[#0078D4] text-white rounded hover:bg-[#106EBE] text-sm"
                            >
                                Create Connection
                            </Link>
                        </div>
                    ) : (
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                            {/* None / Disconnect option */}
                            <button
                                onClick={() => onSelectConnection('')}
                                className={`w-full p-3 border rounded-lg text-left flex items-center gap-3 transition-colors ${selectedConnectionId === '' || selectedConnectionId === null
                                    ? 'border-[#0078D4] bg-[#F0F6FF]'
                                    : 'border-[#E6E6E6] hover:border-[#0078D4]'
                                    }`}
                            >
                                <span className="flex-shrink-0">
                                    <X className="h-5 w-5 text-[#616161]" />
                                </span>
                                <div className="flex-1">
                                    <div className="font-medium text-[#242424]">None (Disconnect)</div>
                                    <div className="text-xs text-[#616161]">
                                        No connection • Project will not run dbt commands
                                    </div>
                                </div>
                                {(selectedConnectionId === '' || selectedConnectionId === null) && (
                                    <span className="text-[#0078D4] text-sm font-medium">Active</span>
                                )}
                            </button>

                            {/* Existing connections */}
                            {connections.map((conn: Connection) => {
                                const isSelected = conn.id === selectedConnectionId;
                                const typeIcon = conn.type === 'postgresql' ? (
                                    <Database className="h-5 w-5 text-[#336791]" />
                                ) : conn.type === 'duckdb' ? (
                                    <Database className="h-5 w-5 text-[#FFC107]" />
                                ) : (
                                    <Database className="h-5 w-5 text-[#0078D4]" />
                                );
                                return (
                                    <button
                                        key={conn.id}
                                        onClick={() => onSelectConnection(conn.id)}
                                        className={`w-full p-3 border rounded-lg text-left flex items-center gap-3 transition-colors ${isSelected
                                            ? 'border-[#0078D4] bg-[#F0F6FF]'
                                            : 'border-[#E6E6E6] hover:border-[#0078D4]'
                                            }`}
                                    >
                                        <span className="flex-shrink-0">{typeIcon}</span>
                                        <div className="flex-1">
                                            <div className="font-medium text-[#242424]">{conn.name}</div>
                                            <div className="text-xs text-[#616161]">
                                                {conn.host}:{conn.port} • {conn.type}
                                            </div>
                                        </div>
                                        {isSelected && (
                                            <span className="text-[#0078D4] text-sm font-medium">Active</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <div className="mt-4 pt-4 border-t border-[#E6E6E6] flex items-center justify-between gap-3">
                        <Link
                            href="/connections"
                            className="text-sm text-[#0078D4] hover:underline"
                        >
                            Manage Connections →
                        </Link>
                        <div className="flex items-center gap-2">
                            {actions}
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm font-medium text-[#242424] border border-[#D1D1D1] rounded hover:bg-[#F3F2F1]"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
