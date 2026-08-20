'use client';

import React from 'react';
import { Check, Copy, FileCode, RefreshCcw } from 'lucide-react';
import { copyTextToClipboard } from '@/lib/clipboard';

interface QueryPlanViewProps {
    adapter: string;
    model: string;
    mode: 'Estimated';
    plan: string;
    signals: string[];
    executionTime?: number;
    isLoading?: boolean;
    loadingStage?: string;
    error?: string;
    onRefresh: () => void;
    onViewCompiledSql: () => void;
}

export default function QueryPlanView({
    adapter,
    model,
    mode,
    plan,
    signals,
    executionTime,
    isLoading,
    loadingStage,
    error,
    onRefresh,
    onViewCompiledSql,
}: QueryPlanViewProps) {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = async () => {
        if (!plan) return;
        await copyTextToClipboard(plan);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    if (isLoading) {
        return (
            <div className="flex h-full items-center justify-center text-[#616161]">
                <div className="flex items-center gap-2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-[#0078D4] border-t-transparent" />
                    <span>{loadingStage || 'Running explain...'}</span>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E6E6E6] bg-[#FAF9F8] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#616161]">
                    <span className="font-medium text-[#242424]">{model || 'No model'}</span>
                    <span>Adapter: {adapter || 'unknown'}</span>
                    <span>Mode: {mode}</span>
                    {executionTime !== undefined && <span>{executionTime.toFixed(2)}s</span>}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleCopy}
                        disabled={!plan}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[#616161] transition-colors hover:bg-[#E6E6E6] hover:text-[#0078D4] disabled:opacity-50"
                        title="Copy plan"
                    >
                        {copied ? <Check className="h-3 w-3 text-[#038387]" /> : <Copy className="h-3 w-3" />}
                        {copied ? 'Copied' : 'Copy plan'}
                    </button>
                    <button
                        onClick={onViewCompiledSql}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[#616161] transition-colors hover:bg-[#E6E6E6] hover:text-[#0078D4]"
                        title="View compiled SQL"
                    >
                        <FileCode className="h-3 w-3" /> View compiled SQL
                    </button>
                    <button
                        onClick={onRefresh}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[#616161] transition-colors hover:bg-[#E6E6E6] hover:text-[#0078D4]"
                        title="Refresh"
                    >
                        <RefreshCcw className="h-3 w-3" /> Refresh
                    </button>
                </div>
            </div>

            {error ? (
                <div className="p-4 text-[#D32F2F]">
                    <div className="mb-2 font-semibold">Explain Error</div>
                    <pre className="whitespace-pre-wrap rounded border border-[#FECACA] bg-[#FEF2F2] p-3 text-sm">{error}</pre>
                </div>
            ) : (
                <>
                    <div className="border-b border-[#E6E6E6] px-3 py-2">
                        <div className="mb-1 text-xs font-semibold uppercase text-[#616161]">Optimization signals</div>
                        <div className="flex flex-wrap gap-1.5">
                            {signals.length > 0 ? (
                                signals.map((signal) => (
                                    <span key={signal} className="rounded border border-[#FCE8A2] bg-[#FFF4CE] px-2 py-0.5 text-xs text-[#8A6100]">
                                        {signal}
                                    </span>
                                ))
                            ) : (
                                <span className="text-xs text-[#616161]">No obvious signals detected</span>
                            )}
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto bg-[#FAF9F8] p-3">
                        <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-[#242424]">{plan || 'No query plan yet'}</pre>
                    </div>
                </>
            )}
        </div>
    );
}
