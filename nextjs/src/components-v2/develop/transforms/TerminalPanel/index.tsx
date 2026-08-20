'use client';

/**
 * TerminalPanel - Bottom panel with terminal output and tabs
 * Updated to light theme matching overall UI
 */

import React, { useEffect, useRef, useState } from 'react';
import { XCircle } from 'lucide-react';
import TerminalOutput from '@/components-v2/develop/workspace/TerminalOutput';
import QueryResultsTable from '@/components-v2/develop/workspace/QueryResultsTable';
import CompiledSQLView from '@/components-v2/develop/workspace/CompiledSQLView';
import QueryPlanView from '@/components-v2/develop/workspace/QueryPlanView';
import LineageView from '@/components-v2/develop/workspace/LineageView';

type TerminalTabType = 'results' | 'lineage' | 'compiled' | 'queryPlan' | 'logs';
type QueryPanelView = 'results' | 'plan';

interface QueryResults {
    data: Record<string, unknown>[];
    columns: string[];
    columnTypes?: Record<string, string>;
    rowCount?: number;
    executionTime?: number;
}

interface LineageNode {
    id: string;
    name: string;
    type: string;
    schema?: string;
    position?: 'upstream' | 'current' | 'downstream';
    columns?: string[];
}

interface LineageEdge {
    from: string;
    to: string;
}

interface TerminalPanelProps {
    isOpen: boolean;
    height: number;
    currentTab: TerminalTabType;
    terminalOutput: string[];
    terminalInput: string;
    isCommandRunning: boolean;
    queryResults: QueryResults;
    queryPanelView: QueryPanelView;
    queryLoading: boolean;
    queryError: string | null;
    compiledSQL: string;
    compiledLoading: boolean;
    compiledError: string | null;
    lineageNodes: LineageNode[];
    lineageEdges: LineageEdge[];
    columnLineage: Record<string, { column: string; table: string; expression?: string }[]>;
    lineageLoading: boolean;
    lineageError: string | null;
    selectedFile: string | null;
    queryPlan: {
        adapter: string;
        model: string;
        mode: 'Estimated';
        plan: string;
        signals: string[];
        executionTime?: number;
        compiledSql?: string;
    };
    queryPlanLoading: boolean;
    queryPlanLoadingStage: string | null;
    queryPlanError: string | null;
    onTabChange: (tab: TerminalTabType) => void;
    onQueryPanelViewChange: (view: QueryPanelView) => void;
    onClose: () => void;
    onHeightChange: (height: number) => void;
    onLoadLineage: () => void;
    onRefreshQueryPlan: () => void;
    onClearTab: () => void;
    onTerminalInputChange: (value: string) => void;
    onTerminalSubmit: (e: React.FormEvent) => void;
    onCancelCommand: () => void;
}

export default function TerminalPanel({
    isOpen,
    height,
    currentTab,
    terminalOutput,
    terminalInput,
    isCommandRunning,
    queryResults,
    queryPanelView,
    queryLoading,
    queryError,
    compiledSQL,
    compiledLoading,
    compiledError,
    lineageNodes,
    lineageEdges,
    columnLineage,
    lineageLoading,
    lineageError,
    selectedFile,
    queryPlan,
    queryPlanLoading,
    queryPlanLoadingStage,
    queryPlanError,
    onTabChange,
    onQueryPanelViewChange,
    onClose,
    onHeightChange,
    onLoadLineage,
    onRefreshQueryPlan,
    onClearTab,
    onTerminalInputChange,
    onTerminalSubmit,
    onCancelCommand,
}: TerminalPanelProps) {
    // Command history for the terminal input (ArrowUp / ArrowDown recall).
    // Stored oldest-first; `historyIndex === null` means the user is editing
    // a fresh line rather than browsing history.
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);

    const handleSubmit = (e: React.FormEvent) => {
        const command = terminalInput.trim();
        if (command) {
            setCommandHistory((prev) =>
                prev[prev.length - 1] === command ? prev : [...prev, command]
            );
        }
        setHistoryIndex(null);
        onTerminalSubmit(e);
    };

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        // Ctrl+C to cancel running command
        if (e.ctrlKey && e.key === 'c' && isCommandRunning) {
            e.preventDefault();
            onCancelCommand();
            return;
        }
        if (commandHistory.length === 0) return;

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const nextIndex =
                historyIndex === null ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
            setHistoryIndex(nextIndex);
            onTerminalInputChange(commandHistory[nextIndex]);
        } else if (e.key === 'ArrowDown') {
            if (historyIndex === null) return;
            e.preventDefault();
            const nextIndex = historyIndex + 1;
            if (nextIndex >= commandHistory.length) {
                setHistoryIndex(null);
                onTerminalInputChange('');
            } else {
                setHistoryIndex(nextIndex);
                onTerminalInputChange(commandHistory[nextIndex]);
            }
        }
    };

    const resizeBarRef = useRef<HTMLDivElement>(null);
    const resizeState = useRef<{
        pointerId: number;
        workspaceBottom: number;
        maxHeight: number;
    } | null>(null);

    const stopResize = (target?: HTMLDivElement) => {
        const state = resizeState.current;
        if (state && target?.hasPointerCapture(state.pointerId)) {
            target.releasePointerCapture(state.pointerId);
        }
        resizeState.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    };

    useEffect(() => () => stopResize(), []);

    useEffect(() => {
        const workspace = resizeBarRef.current?.parentElement;
        if (!isOpen || !workspace) return;

        const observer = new ResizeObserver(([entry]) => {
            const maxHeight = Math.max(100, entry.contentRect.height - 120);
            if (height > maxHeight) onHeightChange(maxHeight);
        });
        observer.observe(workspace);
        return () => observer.disconnect();
    }, [height, isOpen, onHeightChange]);

    if (!isOpen) return null;

    return (
        <>
            {/* Terminal Resize Bar - Light theme */}
            <div
                ref={resizeBarRef}
                className="h-2 touch-none bg-[#E6E6E6] cursor-ns-resize flex items-center justify-center hover:bg-[#0078D4] transition-colors flex-shrink-0"
                onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const workspace = e.currentTarget.parentElement;
                    if (!workspace) return;
                    const workspaceRect = workspace.getBoundingClientRect();
                    resizeState.current = {
                        pointerId: e.pointerId,
                        workspaceBottom: workspaceRect.bottom,
                        maxHeight: Math.max(100, workspaceRect.height - 120),
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                    document.body.style.cursor = 'ns-resize';
                    document.body.style.userSelect = 'none';
                }}
                onPointerMove={(e: React.PointerEvent<HTMLDivElement>) => {
                    const state = resizeState.current;
                    if (!state || state.pointerId !== e.pointerId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const newHeight = Math.max(100, Math.min(state.maxHeight, state.workspaceBottom - e.clientY));
                    onHeightChange(newHeight);
                }}
                onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stopResize(e.currentTarget);
                }}
                onPointerCancel={(e: React.PointerEvent<HTMLDivElement>) => {
                    stopResize(e.currentTarget);
                }}
            >
                <div className="w-12 h-1 bg-[#C8C8C8] rounded-full" />
            </div>

            {/* Terminal Panel - Light theme */}
            <div style={{ height }} className="bg-white border-t border-[#E6E6E6] flex flex-col flex-shrink-0 min-w-0 overflow-hidden">
                {/* Terminal Header with Tabs */}
                <div className="flex items-center justify-between bg-[#F3F2F1] border-b border-[#E6E6E6]">
                    {/* Tabs */}
                    <div className="flex items-center">
                        <button
                            onClick={() => onTabChange('results')}
                            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${currentTab === 'results'
                                ? 'text-[#0078D4] border-[#0078D4] bg-white'
                                : 'text-[#616161] border-transparent hover:text-[#0078D4] hover:bg-white'
                                }`}
                        >
                            Query
                        </button>
                        <button
                            onClick={() => {
                                onTabChange('lineage');
                                onLoadLineage();
                            }}
                            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${currentTab === 'lineage'
                                ? 'text-[#0078D4] border-[#0078D4] bg-white'
                                : 'text-[#616161] border-transparent hover:text-[#0078D4] hover:bg-white'
                                }`}
                        >
                            Lineage
                        </button>
                        <button
                            onClick={() => onTabChange('compiled')}
                            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${currentTab === 'compiled'
                                ? 'text-[#0078D4] border-[#0078D4] bg-white'
                                : 'text-[#616161] border-transparent hover:text-[#0078D4] hover:bg-white'
                                }`}
                        >
                            Compiled SQL
                        </button>
                        <button
                            onClick={() => onTabChange('logs')}
                            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${currentTab === 'logs'
                                ? 'text-[#0078D4] border-[#0078D4] bg-white'
                                : 'text-[#616161] border-transparent hover:text-[#0078D4] hover:bg-white'
                                }`}
                        >
                            Terminal
                        </button>
                    </div>
                    {/* Right side info & controls */}
                    <div className="flex items-center gap-2 px-3">
                        {currentTab === 'results' && queryPanelView === 'results' && queryResults.rowCount !== undefined && (
                            <span className="text-xs text-[#616161]">
                                {queryResults.rowCount} rows
                                {queryResults.executionTime !== undefined && ` • ${queryResults.executionTime.toFixed(1)}s`}
                            </span>
                        )}
                        <button
                            onClick={onClearTab}
                            className="text-xs text-[#616161] hover:text-[#0078D4] px-2 py-0.5 hover:bg-[#E6E6E6] rounded"
                            title="Clear"
                        >
                            Clear
                        </button>
                        <button
                            onClick={onClose}
                            className="text-xs text-[#616161] hover:text-[#D32F2F] px-1.5 py-0.5 hover:bg-[#E6E6E6] rounded"
                            title="Close"
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-hidden bg-white">
                    {currentTab === 'results' && (
                        <div className="flex h-full min-h-0 flex-col bg-white">
                            <div className="flex items-center gap-1 border-b border-[#E6E6E6] bg-[#FAF9F8] px-3 py-1.5">
                                <button
                                    onClick={() => onQueryPanelViewChange('results')}
                                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${queryPanelView === 'results'
                                        ? 'bg-white text-[#0078D4] shadow-sm ring-1 ring-[#D0D0D0]'
                                        : 'text-[#616161] hover:bg-[#E6E6E6] hover:text-[#0078D4]'
                                        }`}
                                >
                                    Results
                                </button>
                                <button
                                    onClick={() => onQueryPanelViewChange('plan')}
                                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${queryPanelView === 'plan'
                                        ? 'bg-white text-[#0078D4] shadow-sm ring-1 ring-[#D0D0D0]'
                                        : 'text-[#616161] hover:bg-[#E6E6E6] hover:text-[#0078D4]'
                                        }`}
                                >
                                    Plan
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 overflow-hidden">
                                {queryPanelView === 'results' ? (
                                    <QueryResultsTable
                                        data={queryResults.data}
                                        columns={queryResults.columns}
                                        columnTypes={queryResults.columnTypes}
                                        rowCount={queryResults.rowCount}
                                        executionTime={queryResults.executionTime}
                                        isLoading={queryLoading}
                                        error={queryError || undefined}
                                        onCancel={onCancelCommand}
                                    />
                                ) : (
                                    <QueryPlanView
                                        adapter={queryPlan.adapter}
                                        model={queryPlan.model}
                                        mode={queryPlan.mode}
                                        plan={queryPlan.plan}
                                        signals={queryPlan.signals}
                                        executionTime={queryPlan.executionTime}
                                        isLoading={queryPlanLoading}
                                        loadingStage={queryPlanLoadingStage || undefined}
                                        error={queryPlanError || undefined}
                                        onRefresh={onRefreshQueryPlan}
                                        onViewCompiledSql={() => onTabChange('compiled')}
                                    />
                                )}
                            </div>
                        </div>
                    )}
                    {currentTab === 'lineage' && (
                        <LineageView
                            nodes={lineageNodes}
                            edges={lineageEdges}
                            columnLineage={columnLineage}
                            currentModel={selectedFile?.split('/').pop()?.replace('.sql', '')}
                            isLoading={lineageLoading}
                            error={lineageError || undefined}
                            onRefresh={onLoadLineage}
                        />
                    )}
                    {currentTab === 'compiled' && (
                        <CompiledSQLView
                            sql={compiledSQL}
                            isLoading={compiledLoading}
                            error={compiledError || undefined}
                        />
                    )}
                    {currentTab === 'logs' && (
                        <div className="h-full flex flex-col bg-[#FAF9F8]">
                            <div className="flex-1 overflow-auto p-3 font-mono text-sm">
                                <TerminalOutput lines={terminalOutput} />
                            </div>
                            {/* Terminal Input - Light theme */}
                            <form onSubmit={handleSubmit} className="px-3 py-2 bg-white border-t border-[#E6E6E6]">
                                <div className="flex items-center gap-2">
                                    <span className="text-[#038387] font-mono text-sm font-bold">$</span>
                                    <input
                                        type="text"
                                        value={terminalInput}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                            setHistoryIndex(null);
                                            onTerminalInputChange(e.target.value);
                                        }}
                                        onKeyDown={handleInputKeyDown}
                                        placeholder={isCommandRunning ? "Press Ctrl+C to stop..." : "↑ for history · dbt run, dbt compile, dbt test..."}
                                        className="flex-1 bg-[#FAF9F8] border border-[#E6E6E6] rounded px-3 py-1.5 font-mono text-sm text-[#242424] focus:outline-none focus:border-[#0078D4]"
                                        disabled={isCommandRunning}
                                    />
                                    {isCommandRunning ? (
                                        <button
                                            type="button"
                                            onClick={onCancelCommand}
                                            className="px-3 py-1.5 bg-[#D32F2F] text-white text-sm rounded hover:bg-[#B71C1C] flex items-center gap-1"
                                        >
                                            <XCircle className="h-4 w-4" /> Stop
                                        </button>
                                    ) : (
                                        <button type="submit" className="px-3 py-1.5 bg-[#0078D4] text-white text-sm rounded hover:bg-[#106EBE]">
                                            Run
                                        </button>
                                    )}
                                </div>
                                {isCommandRunning && (
                                    <div className="text-xs text-[#616161] mt-1 flex items-center gap-1">
                                        <span className="animate-pulse text-[#0078D4]">●</span> Running... Press Ctrl+C or click Stop to cancel
                                    </div>
                                )}
                            </form>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
