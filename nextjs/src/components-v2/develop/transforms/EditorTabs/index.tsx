'use client';

/**
 * EditorTabs - Tab bar, editor header, and code editor
 * Added: Diff Editor toggle for comparing with git HEAD
 */

import React, { useState } from 'react';
import { X, FileCode, Play, PlayCircle, GitCompare, Plus, SlidersHorizontal, ChevronDown } from 'lucide-react';
import CodeEditor, { formatFile } from '@/components-v2/develop/workspace/CodeEditor';
import DiffEditor from '@/components-v2/develop/workspace/DiffEditor';
import { type OpenTab } from '@/lib/hooks';
import type { DbtIntellisenseResponse } from '@/lib/api/dbt';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components-v2/ui/dropdown-menu';

interface EditorTabsProps {
    projectId: string;
    tabs: OpenTab[];
    activeTabPath: string | null;
    selectedFile: string | null;
    fileContent: string;
    onTabChange: (path: string) => void;
    onTabClose: (path: string, e: React.MouseEvent) => void;
    onContentChange: (value: string | undefined) => void;
    onSave: () => void;
    onPreview: () => void;
    onExplain: () => void;
    onCompile: () => void;
    onRun: () => void;
    onCloseCurrentTab?: () => void;
    onOpenDbtArgs?: () => void;
    onNewDraft?: () => void;
    onRunParse?: () => void;
    onOpenDefinition?: (path: string) => void;
    onFormatContent: (formatted: string) => void;
    getLanguage: (path: string) => string;
    isSaving?: boolean;  // Show saving indicator when true
    dbtCommandArgs?: string;
    dbtFullRefresh?: boolean;
    dbtIntellisense?: DbtIntellisenseResponse | null;
    intellisenseLoading?: boolean;
    intellisenseError?: string | null;
    diffRequest?: { path: string; requestId: number } | null;
}

export default function EditorTabs({
    projectId,
    tabs,
    activeTabPath,
    selectedFile,
    fileContent,
    onTabChange,
    onTabClose,
    onContentChange,
    onSave,
    onPreview,
    onExplain,
    onCompile,
    onRun,
    onCloseCurrentTab,
    onOpenDbtArgs,
    onNewDraft,
    onRunParse,
    onOpenDefinition,
    onFormatContent,
    getLanguage,
    isSaving: _isSaving = false,
    dbtCommandArgs = '',
    dbtFullRefresh = false,
    dbtIntellisense,
    intellisenseLoading = false,
    intellisenseError,
    diffRequest,
}: EditorTabsProps) {
    const [showDiff, setShowDiff] = useState(false);

    // Reset diff view when file changes
    React.useEffect(() => {
        setShowDiff(!!selectedFile && diffRequest?.path === selectedFile);
    }, [selectedFile, diffRequest]);


    // Check if current file is a SQL model (in models/ directory)
    const activePath = selectedFile || activeTabPath;
    const activeTab = tabs.find(t => t.path === activePath);
    const isDraft = !!activeTab?.isDraft;
    const isSQLFile = activePath
        ? activePath.toLowerCase().endsWith('.sql') || (activeTab?.name || '').toLowerCase().endsWith('.sql')
        : false;
    const hasDbtArgs = dbtCommandArgs.trim().length > 0 || dbtFullRefresh;

    return (
        <>
            {/* Tab Bar - fixed height, scrollable */}
            <div className="bg-[#F3F2F1] border-b border-[#E6E6E6] flex items-center overflow-x-auto flex-shrink-0 min-h-[36px]">
                {tabs.map((tab) => (
                    <div
                        key={tab.path}
                        className={`flex items-center gap-2 px-4 py-2 border-r border-[#E6E6E6] cursor-pointer hover:bg-white transition-colors min-w-[120px] ${activeTabPath === tab.path
                            ? 'bg-white border-b-2 border-b-[#0078D4]'
                            : tab.isDirty
                                ? 'text-[#0078D4]'
                                : 'text-[#616161]'
                            }`}
                        onClick={() => onTabChange(tab.path)}
                    >
                        <span className="text-sm flex-1 truncate" title={tab.path}>
                            {tab.name || tab.path.split('/').pop()}
                            {tab.isDirty && ' •'}
                        </span>
                        <button
                            onClick={(e) => onTabClose(tab.path, e)}
                            className="hover:bg-[#E6E6E6] rounded p-0.5"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                ))}
                {tabs.length === 0 && (
                    <div className="px-3 py-2 text-sm text-[#616161]">No files open</div>
                )}
                {onNewDraft && (
                    <button
                        onClick={onNewDraft}
                        className="ml-1 p-1.5 hover:bg-white rounded text-[#616161] hover:text-[#0078D4] transition-colors"
                        title="New SQL Draft (Ctrl+N / Cmd+N)"
                        aria-label="New SQL Draft"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                )}
            </div>

            {selectedFile ? (
                <>
                    {/* Editor Header */}
                    <div className="bg-[#FAF9F8] border-b border-[#E6E6E6] px-4 py-2 flex min-w-0 items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <FileCode className="h-4 w-4 flex-shrink-0 text-[#038387]" />
                            <span className="min-w-0 truncate text-sm font-medium text-[#242424]" title={activePath || undefined}>
                                {isDraft ? activeTab?.name : activePath}
                            </span>
                            {isDraft && (
                                <span className="flex-shrink-0 text-xs text-[#8A6100]">(draft)</span>
                            )}
                            {activeTab?.isDirty && (
                                <span className="flex-shrink-0 text-xs text-[#0078D4]">(unsaved)</span>
                            )}

                            {dbtIntellisense?.status === 'missing_manifest' && (
                                <button
                                    onClick={onRunParse}
                                    className="text-xs px-2 py-0.5 bg-[#FFF4CE] text-[#8A6100] rounded hover:bg-[#FCE8A2] transition-colors"
                                    title="Run dbt parse to enable project-aware autocomplete"
                                >
                                    Run dbt parse
                                </button>
                            )}

                            {intellisenseLoading && (
                                <span className="text-xs text-[#616161]">Loading dbt metadata...</span>
                            )}

                            {intellisenseError && (
                                <span className="text-xs text-[#A80000]" title={intellisenseError}>
                                    dbt metadata unavailable
                                </span>
                            )}

                            {showDiff && (
                                <span className="text-xs px-2 py-0.5 bg-[#0078D4]/10 text-[#0078D4] rounded ml-2">
                                    Diff View
                                </span>
                            )}
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                            {/* Diff toggle button - always visible, first on the right */}
                            <button
                                onClick={() => setShowDiff(!showDiff)}
                                disabled={isDraft}
                                className={`p-1.5 rounded flex items-center gap-1 text-sm transition-colors ${showDiff
                                    ? 'bg-[#0078D4] text-white hover:bg-[#106EBE]'
                                    : isDraft
                                        ? 'text-[#A0A0A0] cursor-not-allowed'
                                        : 'hover:bg-[#E6E6E6] text-[#616161]'
                                    }`}
                                title={isDraft ? 'Save draft before diff' : showDiff ? 'Exit diff view' : 'Compare with Git HEAD'}
                            >
                                <GitCompare className="h-4 w-4" />
                                {showDiff ? 'Exit Diff' : 'Diff'}
                            </button>

                            {/* SQL Action buttons */}
                            {isSQLFile && (
                                <>
                                    <div className="w-px h-4 bg-[#E6E6E6]" />
                                    <button
                                        onClick={() => {
                                            if (selectedFile) {
                                                const formatted = formatFile(selectedFile, fileContent);
                                                onFormatContent(formatted);
                                            }
                                        }}
                                        className="p-1.5 hover:bg-[#E6E6E6] rounded flex items-center gap-1 text-sm text-[#616161] transition-colors"
                                        title="Format SQL (Shift+Alt+F)"
                                    >
                                        <FileCode className="h-4 w-4" /> Format
                                    </button>
                                    <div className="w-px h-4 bg-[#E6E6E6]" />
                                    <button
                                        onClick={onOpenDbtArgs}
                                        className={`relative p-1.5 rounded flex items-center gap-1 text-sm transition-colors ${hasDbtArgs
                                            ? 'bg-[#0078D4]/10 text-[#0078D4] hover:bg-[#0078D4]/15'
                                            : 'hover:bg-[#E6E6E6] text-[#616161]'
                                            }`}
                                        title={hasDbtArgs ? `dbt args enabled: ${[dbtCommandArgs, dbtFullRefresh ? '--full-refresh' : ''].filter(Boolean).join(' ')}` : 'Set dbt arguments'}
                                    >
                                        <SlidersHorizontal className="h-4 w-4" /> Args
                                        {hasDbtArgs && (
                                            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#107C10]" />
                                        )}
                                    </button>
                                    <div className="w-px h-4 bg-[#E6E6E6]" />
                                    <div className="flex items-center rounded text-[#0078D4] transition-colors hover:bg-[#E6E6E6]">
                                        <button
                                            onClick={onPreview}
                                            className="flex items-center gap-1 rounded-l p-1.5 text-sm"
                                            title="Preview Data (Ctrl+Enter / Cmd+Enter)"
                                        >
                                            <Play className="h-4 w-4" /> Preview
                                        </button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    className="border-l border-[#D0D0D0] p-1.5 text-[#0078D4] hover:bg-[#E6E6E6]"
                                                    title="Preview actions"
                                                    aria-label="Preview actions"
                                                >
                                                    <ChevronDown className="h-4 w-4" />
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-48">
                                                <DropdownMenuItem onClick={onPreview}>
                                                    Preview data
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={onExplain}>
                                                    Explain query plan
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                    <div className="w-px h-4 bg-[#E6E6E6]" />
                                    <button
                                        onClick={onCompile}
                                        className="p-1.5 hover:bg-[#E6E6E6] rounded flex items-center gap-1 text-sm text-[#616161] transition-colors"
                                        title="Compile SQL"
                                    >
                                        <FileCode className="h-4 w-4" /> Compile
                                    </button>
                                    <div className="w-px h-4 bg-[#E6E6E6]" />
                                    <button
                                        onClick={onRun}
                                        className="p-1.5 hover:bg-[#E6E6E6] rounded flex items-center gap-1 text-sm text-[#038387] transition-colors"
                                        title="Run Model (Ctrl+Shift+Enter / Cmd+Shift+Enter)"
                                    >
                                        <PlayCircle className="h-4 w-4" /> Run
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Code Editor or Diff Editor */}
                    <div className="flex-1 min-h-0 overflow-hidden">
                        {showDiff ? (
                            <DiffEditor
                                projectId={projectId}
                                filePath={selectedFile}
                                currentContent={fileContent}
                                language={getLanguage(selectedFile)}
                                onClose={() => setShowDiff(false)}
                            />
                        ) : (
                            <CodeEditor
                                value={fileContent}
                                onChange={onContentChange}
                                language={getLanguage(selectedFile)}
                                fileName={selectedFile || undefined}
                                onSave={onSave}
                                onPreview={onPreview}
                                onRun={onRun}
                                onNewFile={onNewDraft}
                                onCloseFile={onCloseCurrentTab}
                                dbtIntellisense={dbtIntellisense}
                                onOpenDefinition={onOpenDefinition}
                            />
                        )}
                    </div>
                </>
            ) : (
                /* Empty state */
                <div className="flex-1 flex items-center justify-center bg-[#FAF9F8]">
                    <div className="text-center text-[#616161]">
                        <FileCode className="h-16 w-16 mx-auto mb-4 opacity-30" />
                        <p className="text-sm">Select a file to edit</p>
                        <p className="text-xs mt-2 opacity-70">Right-click on files to create/delete</p>
                    </div>
                </div>
            )}
        </>
    );
}
