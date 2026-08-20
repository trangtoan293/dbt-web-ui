'use client';

/**
 * RightPanel - dbt commands dropdown and quick action buttons
 * EXACT COPY from page.tsx lines 1479-1636 (preserving format and UI)
 */

import React, { useState } from 'react';
import { Play, CheckCircle, RefreshCw, Database, Save, Terminal, BookOpen, Package, Sprout, FileText, Plug, Trash2 } from 'lucide-react';
import DbtIcon from '@/components-v2/icons/assets/DbtIcon';
import type { Connection } from '@/components-v2/develop/types';

interface RightPanelProps {
    terminalOpen: boolean;
    docsLoading: boolean;
    projectConnectionId: string | null;
    connections: Connection[];
    isDirty: boolean;  // Whether current file has unsaved changes
    getModelName: () => string;
    onRunDbt: (command: string) => void;
    onGenerateDocs: () => void;
    onOpenDocs: () => void;
    onSaveFile: () => void;
    onToggleTerminal: () => void;
    onOpenConnectionModal: () => void;
    onDeleteProject?: () => void;
    deleteProjectLabel?: string;
}

export default function RightPanel({
    terminalOpen,
    docsLoading,
    projectConnectionId,
    connections,
    isDirty,
    getModelName,
    onRunDbt,
    onGenerateDocs,
    onOpenDocs,
    onSaveFile,
    onToggleTerminal,
    onOpenConnectionModal,
    onDeleteProject,
    deleteProjectLabel = 'Delete Project',
}: RightPanelProps) {
    const [dbtMenuOpen, setDbtMenuOpen] = useState(false);

    return (
        <div className="w-14 bg-white border-l border-[#E6E6E6] flex flex-col items-center py-2 gap-2 flex-shrink-0">
            {/* Model Dropdown Button */}
            <div className="relative">
                <button
                    onClick={() => setDbtMenuOpen(!dbtMenuOpen)}
                    className="p-2 rounded hover:bg-[#F3F2F1] transition-colors border border-[#E6E6E6] hover:border-[#0078D4]"
                    title="dbt Commands"
                >
                    <DbtIcon className="h-5 w-5" />
                </button>

                {/* Dropdown Menu - Opens to the left */}
                {dbtMenuOpen && (
                    <>
                        {/* Backdrop to close dropdown */}
                        <div
                            className="fixed inset-0 z-40"
                            onClick={() => setDbtMenuOpen(false)}
                        />
                        <div className="absolute right-full top-0 mr-1 w-56 bg-white border border-[#E6E6E6] rounded-lg shadow-lg z-50 overflow-hidden">
                            {/* Current Model Section */}
                            <div className="border-b border-[#E6E6E6]">
                                <div className="px-3 py-2 bg-[#FAF9F8] text-xs font-semibold text-[#323130] uppercase tracking-wide">
                                    Current Model
                                </div>
                                <div className="py-1">
                                    <button
                                        onClick={() => { onRunDbt(`run --select ${getModelName()}`); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Play className="h-4 w-4 text-[#0078D4]" />
                                        <span>Run</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt(`run --select +${getModelName()}`); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Play className="h-4 w-4 text-[#0078D4]" />
                                        <span>Run + Upstream</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt(`run --select ${getModelName()}+`); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Play className="h-4 w-4 text-[#0078D4]" />
                                        <span>Run + Downstream</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt(`test --select ${getModelName()}`); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <CheckCircle className="h-4 w-4 text-[#107C10]" />
                                        <span>Test</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt(`show --select ${getModelName()} --limit 100`); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <RefreshCw className="h-4 w-4 text-[#D83B01]" />
                                        <span>Preview (100 rows)</span>
                                    </button>
                                </div>
                            </div>

                            {/* Project Section */}
                            <div>
                                <div className="px-3 py-2 bg-[#FAF9F8] text-xs font-semibold text-[#323130] uppercase tracking-wide">
                                    Project
                                </div>
                                <div className="py-1">
                                    <button
                                        onClick={() => { onRunDbt('run'); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Play className="h-4 w-4 text-[#0078D4]" />
                                        <span>Run All</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt('build'); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Database className="h-4 w-4 text-[#038387]" />
                                        <span>Build All</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt('test'); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <CheckCircle className="h-4 w-4 text-[#107C10]" />
                                        <span>Test All</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt('debug'); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Plug className="h-4 w-4 text-[#038387]" />
                                        <span>Debug Connection</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt('deps'); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Package className="h-4 w-4 text-[#8764B8]" />
                                        <span>Install Dependencies</span>
                                    </button>
                                    <button
                                        onClick={() => { onRunDbt('seed'); setDbtMenuOpen(false); }}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                                    >
                                        <Sprout className="h-4 w-4 text-[#107C10]" />
                                        <span>Seed</span>
                                    </button>
                                    <button
                                        onClick={() => { onGenerateDocs(); setDbtMenuOpen(false); }}
                                        disabled={docsLoading}
                                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2 disabled:opacity-50"
                                    >
                                        <FileText className="h-4 w-4 text-[#0078D4]" />
                                        <span>{docsLoading ? 'Generating...' : 'Generate Docs'}</span>
                                    </button>
                                    {onDeleteProject && (
                                        <>
                                            <div className="my-1 border-t border-[#E6E6E6]" />
                                            <button
                                                onClick={() => { onDeleteProject(); setDbtMenuOpen(false); }}
                                                className="w-full px-3 py-2 text-sm text-left hover:bg-red-50 text-red-600 flex items-center gap-2"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                                <span>{deleteProjectLabel}</span>
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* Quick action buttons */}
            {/* View Docs Button */}
            <button
                onClick={onOpenDocs}
                className="p-2 hover:bg-[#F3F2F1] rounded transition-colors bg-emerald-50 border border-emerald-200"
                title="📖 View dbt Docs (Generate docs first)"
            >
                <BookOpen className="h-5 w-5 text-emerald-600" />
            </button>

            <button
                onClick={onSaveFile}
                disabled={!isDirty}
                className={`p-2 rounded transition-colors ${isDirty
                        ? 'hover:bg-[#F3F2F1] bg-[#038387]/10 border border-[#038387]'
                        : 'opacity-40 cursor-not-allowed'
                    }`}
                title={isDirty ? 'Save File (Ctrl+S)' : 'No unsaved changes'}
            >
                <Save className={`h-5 w-5 ${isDirty ? 'text-[#038387]' : 'text-[#616161]'}`} />
            </button>

            <button
                onClick={onToggleTerminal}
                className={`p-2 hover:bg-[#F3F2F1] rounded transition-colors ${terminalOpen ? 'bg-[#E6E6E6]' : ''}`}
                title="Toggle Terminal"
            >
                <Terminal className="h-5 w-5 text-[#242424]" />
            </button>

            {/* Connection Selector Button */}
            <button
                onClick={onOpenConnectionModal}
                className={`p-2 hover:bg-[#F3F2F1] rounded transition-colors ${projectConnectionId ? 'bg-[#E6E6E6]' : ''}`}
                title={`Connection: ${connections.find(c => c.id === projectConnectionId)?.name || 'Not configured'}`}
            >
                <Database className="h-5 w-5 text-[#038387]" />
            </button>

            <div className="flex-1" />
        </div>
    );
}
