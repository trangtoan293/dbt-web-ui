'use client';

import React from 'react';
import { Check, Copy, Download, XCircle } from 'lucide-react';
import { copyTextToClipboard } from '@/lib/clipboard';

interface QueryResultsTableProps {
    data: Record<string, unknown>[];
    columns: string[];
    columnTypes?: Record<string, string>;
    rowCount?: number;
    executionTime?: number;
    isLoading?: boolean;
    error?: string;
    onCancel?: () => void;  // Cancel handler for Stop button
}

export default function QueryResultsTable({
    data,
    columns,
    columnTypes,
    rowCount,
    executionTime,
    isLoading,
    error,
    onCancel
}: QueryResultsTableProps) {
    const [copied, setCopied] = React.useState(false);

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-[#616161] gap-3">
                <div className="flex items-center gap-2">
                    <div className="animate-spin h-4 w-4 border-2 border-[#0078D4] border-t-transparent rounded-full"></div>
                    <span>Running query...</span>
                </div>
                {onCancel && (
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 bg-[#D32F2F] text-white text-sm rounded hover:bg-[#B71C1C] flex items-center gap-2"
                    >
                        <XCircle className="h-4 w-4" />
                        Stop
                    </button>
                )}
                <p className="text-xs text-[#A0A0A0]">Press Ctrl+C or click Stop to cancel</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 text-[#D32F2F]">
                <div className="font-semibold mb-2">Query Error</div>
                <pre className="text-sm whitespace-pre-wrap bg-[#FEF2F2] p-3 rounded border border-[#FECACA]">{error}</pre>
            </div>
        );
    }

    if (data.length === 0) {
        return (
            <div className="flex items-center justify-center h-full text-[#616161]">
                <div className="text-center">
                    <div className="text-lg mb-1">No results</div>
                    <div className="text-sm">Run a preview query to see results here</div>
                </div>
            </div>
        );
    }

    const formatValue = (value: unknown): string => {
        if (value === null || value === undefined) {
            return '--';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return String(value);
    };

    const getValueColor = (value: unknown): string => {
        if (value === null || value === undefined) {
            return 'text-[#A0A0A0]';
        }
        if (typeof value === 'number') {
            return 'text-[#038387]';
        }
        if (typeof value === 'boolean') {
            return 'text-[#6B69D6]';
        }
        // Check if it looks like a date
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
            return 'text-[#0078D4]';
        }
        return 'text-[#242424]';
    };

    const inferColumnType = (col: string): string | undefined => {
        const values = data
            .map((row) => row[col])
            .filter((value) => value !== null && value !== undefined);

        if (values.length === 0) return undefined;
        if (values.every((value) => typeof value === 'number')) return 'number';
        if (values.every((value) => typeof value === 'boolean')) return 'boolean';
        if (values.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))) return 'date-like';
        if (values.every((value) => typeof value === 'object')) return 'json';
        return 'string';
    };

    const displayColumnType = (col: string): { value: string; inferred: boolean } | undefined => {
        const artifactType = columnTypes?.[col];
        if (artifactType) return { value: artifactType, inferred: false };

        const inferredType = inferColumnType(col);
        return inferredType ? { value: inferredType, inferred: true } : undefined;
    };

    const escapeCsvValue = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const escapeTsvValue = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return text.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
    };

    const handleDownload = () => {
        const csv = [
            columns.map(escapeCsvValue).join(','),
            ...data.map((row) => columns.map((col) => escapeCsvValue(row[col])).join(',')),
        ].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'preview-results.csv';
        link.click();
        URL.revokeObjectURL(url);
    };

    const handleCopy = async () => {
        const tsv = [
            columns.map(escapeTsvValue).join('\t'),
            ...data.map((row) => columns.map((col) => escapeTsvValue(row[col])).join('\t')),
        ].join('\n');

        await copyTextToClipboard(tsv);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className="flex flex-col h-full overflow-hidden bg-white">
            {/* Results info bar */}
            <div className="flex items-center justify-between gap-3 px-3 py-1 text-xs text-[#616161] border-b border-[#E6E6E6] flex-shrink-0 bg-[#FAF9F8]">
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleDownload}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[#242424] hover:text-[#0078D4] hover:bg-[#E6E6E6] rounded"
                        title="Download preview data as CSV"
                    >
                        <Download className="h-3.5 w-3.5" />
                        CSV
                    </button>
                    <button
                        onClick={handleCopy}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[#242424] hover:text-[#0078D4] hover:bg-[#E6E6E6] rounded"
                        title="Copy preview data to clipboard"
                    >
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </div>
                {rowCount !== undefined && (
                    <span>
                        {rowCount} rows
                        {executionTime !== undefined && ` • ${executionTime.toFixed(1)}s`}
                    </span>
                )}
            </div>

            {/* Table container - scrollable both horizontally and vertically */}
            <div className="flex-1 overflow-auto min-w-0">
                <table className="text-sm border-collapse min-w-full">
                    <thead className="sticky top-0 bg-[#F3F2F1]">
                        <tr>
                            <th className="px-3 py-2 text-left text-[#616161] font-medium border-b border-[#E6E6E6] w-8">
                                #
                            </th>
                            {columns.map((col) => (
                                <th
                                    key={col}
                                    className="px-3 py-2 text-left text-[#242424] font-medium border-b border-[#E6E6E6] whitespace-nowrap"
                                >
                                    <div className="flex items-baseline gap-2">
                                        <span>{col}</span>
                                        {displayColumnType(col) && (
                                            <span
                                                className="text-[10px] font-mono uppercase text-[#8A8886]"
                                                title={displayColumnType(col)?.inferred ? 'Inferred from preview rows' : 'From dbt metadata'}
                                            >
                                                {displayColumnType(col)?.value}
                                            </span>
                                        )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {data.map((row, rowIndex) => (
                            <tr
                                key={rowIndex}
                                className="hover:bg-[#F3F2F1] border-b border-[#E6E6E6]"
                            >
                                <td className="px-3 py-2 text-[#A0A0A0] font-mono">
                                    {rowIndex + 1}
                                </td>
                                {columns.map((col) => (
                                    <td
                                        key={col}
                                        className={`px-3 py-2 font-mono whitespace-nowrap ${getValueColor(row[col])}`}
                                    >
                                        {formatValue(row[col])}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
