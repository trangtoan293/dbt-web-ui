'use client';

/**
 * DiffEditor - Monaco Diff Editor for comparing file changes with git HEAD
 * Uses Monaco's built-in DiffEditor component
 */

import dynamic from 'next/dynamic';
import { useEffect, useState, useCallback } from 'react';
import { gitApi } from '@/lib/api';
import { buildGitShowHeadCommand } from '@/lib/git/diffPath';
import { Loader2, GitCompare, X, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';

// Dynamically import Monaco DiffEditor to prevent SSR issues
const MonacoDiffEditor = dynamic(
    () => import('@monaco-editor/react').then((mod) => mod.DiffEditor),
    { ssr: false }
);

interface DiffEditorProps {
    projectId: string;
    filePath: string;
    currentContent: string;
    language?: string;
    height?: string;
    theme?: 'light' | 'dark';
    onClose?: () => void;
}

export default function DiffEditor({
    projectId,
    filePath,
    currentContent,
    language = 'sql',
    height = '100%',
    theme = 'light',
    onClose,
}: DiffEditorProps) {
    const [originalContent, setOriginalContent] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [renderSideBySide, setRenderSideBySide] = useState(true);

    // Get language mapping
    const getLanguage = (lang: string) => {
        const mapping: Record<string, string> = {
            sql: 'sql',
            yml: 'yaml',
            yaml: 'yaml',
            md: 'markdown',
            json: 'json',
            py: 'python',
            csv: 'plaintext',
        };
        return mapping[lang] || 'sql';
    };

    // Load original content from git HEAD
    const loadOriginalContent = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            // Use git show to get file content from HEAD
            const result = await gitApi.exec(projectId, buildGitShowHeadCommand(filePath));

            if (result.success) {
                setOriginalContent(result.stdout || '');
            } else if (result.stderr?.includes('does not exist')) {
                // File is new (untracked)
                setOriginalContent('');
                setError(null);
            } else {
                setOriginalContent('');
                setError(result.stderr || 'Failed to load original version');
            }
        } catch (err) {
            console.error('Error loading git content:', err);
            setOriginalContent('');
            setError('Cannot connect to dbt-runner');
        } finally {
            setIsLoading(false);
        }
    }, [projectId, filePath]);

    useEffect(() => {
        loadOriginalContent();
    }, [loadOriginalContent]);

    // Get file name from path
    const fileName = filePath.split('/').pop() || filePath;

    return (
        <div className="flex flex-col h-full bg-white">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#E6E6E6] bg-[#FAF9F8]">
                <div className="flex items-center gap-2">
                    <GitCompare className="h-4 w-4 text-[#0078D4]" />
                    <span className="text-sm font-medium text-[#242424]">
                        Compare Changes
                    </span>
                    <span className="text-xs text-[#616161] px-2 py-0.5 bg-[#E6E6E6] rounded">
                        {fileName}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {/* Toggle side-by-side / inline */}
                    <button
                        onClick={() => setRenderSideBySide(!renderSideBySide)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-[#616161] hover:text-[#242424] hover:bg-[#E6E6E6] rounded transition-colors"
                        title={renderSideBySide ? 'Switch to inline view' : 'Switch to side-by-side view'}
                    >
                        {renderSideBySide ? (
                            <>
                                <ChevronLeft className="h-3 w-3" />
                                <ChevronRight className="h-3 w-3 -ml-2" />
                                <span>Inline</span>
                            </>
                        ) : (
                            <>
                                <ChevronLeft className="h-3 w-3" />
                                <span className="mx-0.5">|</span>
                                <ChevronRight className="h-3 w-3" />
                                <span>Side by Side</span>
                            </>
                        )}
                    </button>

                    {/* Refresh */}
                    <button
                        onClick={loadOriginalContent}
                        className="p-1.5 text-[#616161] hover:text-[#242424] hover:bg-[#E6E6E6] rounded transition-colors"
                        title="Refresh"
                        disabled={isLoading}
                    >
                        <RotateCcw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                    </button>

                    {/* Close */}
                    {onClose && (
                        <button
                            onClick={onClose}
                            className="p-1.5 text-[#616161] hover:text-[#242424] hover:bg-[#E6E6E6] rounded transition-colors"
                            title="Close diff view"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* Labels */}
            <div className="flex border-b border-[#E6E6E6] text-xs">
                <div className="flex-1 px-3 py-1.5 bg-[#FEF2F2] text-[#B91C1C] border-r border-[#E6E6E6]">
                    <span className="font-medium">Original</span>
                    <span className="text-[#999] ml-2">(HEAD)</span>
                </div>
                <div className="flex-1 px-3 py-1.5 bg-[#F0FDF4] text-[#166534]">
                    <span className="font-medium">Modified</span>
                    <span className="text-[#999] ml-2">(Working Tree)</span>
                </div>
            </div>

            {/* Editor */}
            <div className="flex-1 relative">
                {isLoading ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-white">
                        <div className="flex items-center gap-2 text-[#616161]">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            <span>Loading original version...</span>
                        </div>
                    </div>
                ) : error && !originalContent ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-white">
                        <div className="text-center">
                            <GitCompare className="h-8 w-8 text-[#A0A0A0] mx-auto mb-2" />
                            <p className="text-sm text-[#616161]">{error}</p>
                            <p className="text-xs text-[#A0A0A0] mt-1">
                                The file content shown is the current working version
                            </p>
                        </div>
                    </div>
                ) : (
                    <MonacoDiffEditor
                        key={`diff-${renderSideBySide ? 'side' : 'inline'}`}
                        height={height}
                        language={getLanguage(language)}
                        original={originalContent}
                        modified={currentContent}
                        theme={theme === 'dark' ? 'vs-dark' : 'vs-light'}
                        options={{
                            readOnly: true,
                            renderSideBySide,
                            minimap: { enabled: false },
                            fontSize: 13,
                            fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
                            scrollBeyondLastLine: false,
                            wordWrap: 'on',
                            automaticLayout: true,
                            padding: { top: 8, bottom: 8 },
                            folding: true,
                            lineNumbers: 'on',
                            renderOverviewRuler: true,
                            diffWordWrap: 'on',
                            ignoreTrimWhitespace: false,
                            renderIndicators: true,
                            originalEditable: false,
                        }}
                    />
                )}
            </div>

            {/* Status bar */}
            <div className="flex items-center justify-between px-3 py-1 border-t border-[#E6E6E6] bg-[#FAF9F8] text-xs text-[#616161]">
                <span>
                    {error ? (
                        <span className="text-[#B7791F]">{error}</span>
                    ) : (
                        <>Comparing with HEAD</>
                    )}
                </span>
                <span>
                    {renderSideBySide ? 'Side by Side' : 'Inline'} View
                </span>
            </div>
        </div>
    );
}
