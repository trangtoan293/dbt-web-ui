'use client';

import React from 'react';
import { Copy, Check } from 'lucide-react';
import { copyTextToClipboard } from '@/lib/clipboard';

interface CompiledSQLViewProps {
    sql: string;
    isLoading?: boolean;
    error?: string;
}

export default function CompiledSQLView({ sql, isLoading, error }: CompiledSQLViewProps) {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = async () => {
        try {
            await copyTextToClipboard(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full text-[#616161]">
                <div className="flex items-center gap-2">
                    <div className="animate-spin h-4 w-4 border-2 border-[#0078D4] border-t-transparent rounded-full"></div>
                    <span>Compiling SQL...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 text-[#D32F2F]">
                <div className="font-semibold mb-2">Compilation Error</div>
                <pre className="text-sm whitespace-pre-wrap bg-[#FEF2F2] p-3 rounded border border-[#FECACA]">{error}</pre>
            </div>
        );
    }

    if (!sql) {
        return (
            <div className="flex items-center justify-center h-full text-[#616161]">
                <div className="text-center">
                    <div className="text-lg mb-1">No compiled SQL</div>
                    <div className="text-sm">Run &quot;dbt compile&quot; to see the compiled SQL here</div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-white">
            {/* Toolbar */}
            <div className="flex justify-end px-3 py-1 border-b border-[#E6E6E6] bg-[#FAF9F8]">
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-[#616161] hover:text-[#0078D4] hover:bg-[#E6E6E6] rounded transition-colors"
                    title="Copy to clipboard"
                >
                    {copied ? (
                        <>
                            <Check className="h-3 w-3 text-[#038387]" />
                            <span className="text-[#038387]">Copied!</span>
                        </>
                    ) : (
                        <>
                            <Copy className="h-3 w-3" />
                            <span>Copy</span>
                        </>
                    )}
                </button>
            </div>

            {/* SQL Content */}
            <div className="flex-1 overflow-auto p-3 bg-[#FAF9F8]">
                <pre className="text-sm font-mono text-[#242424] whitespace-pre-wrap">
                    {highlightSQL(sql)}
                </pre>
            </div>
        </div>
    );
}

function highlightSQL(sql: string): React.ReactNode[] {
    const keywords = [
        'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
        'ON', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS', 'NULL',
        'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL',
        'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE',
        'ALTER', 'DROP', 'INDEX', 'VIEW', 'AS', 'DISTINCT', 'CASE', 'WHEN', 'THEN',
        'ELSE', 'END', 'CAST', 'COALESCE', 'NULLIF', 'WITH', 'RECURSIVE', 'CTE',
        'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD',
        'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'TRUE', 'FALSE', 'CROSS', 'NATURAL'
    ];

    const result: React.ReactNode[] = [];
    let keyIndex = 0;

    // Simple tokenization
    const lines = sql.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const tokens: React.ReactNode[] = [];

        // Match words, strings, numbers, and other characters
        const regex = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|--.*$|\b\d+\.?\d*\b|\b\w+\b|[^\s])/g;
        let match;
        let lastIndex = 0;

        while ((match = regex.exec(line)) !== null) {
            // Add any whitespace before this match
            if (match.index > lastIndex) {
                tokens.push(line.slice(lastIndex, match.index));
            }

            const token = match[0];

            if (token.startsWith('--')) {
                // Comment
                tokens.push(
                    <span key={keyIndex++} className="text-[#616161] italic">
                        {token}
                    </span>
                );
            } else if (token.startsWith("'") || token.startsWith('"')) {
                // String
                tokens.push(
                    <span key={keyIndex++} className="text-[#038387]">
                        {token}
                    </span>
                );
            } else if (/^\d+\.?\d*$/.test(token)) {
                // Number
                tokens.push(
                    <span key={keyIndex++} className="text-[#6B69D6]">
                        {token}
                    </span>
                );
            } else if (keywords.includes(token.toUpperCase())) {
                // SQL keyword
                tokens.push(
                    <span key={keyIndex++} className="text-[#0078D4] font-semibold">
                        {token}
                    </span>
                );
            } else {
                tokens.push(token);
            }

            lastIndex = match.index + token.length;
        }

        // Add remaining text
        if (lastIndex < line.length) {
            tokens.push(line.slice(lastIndex));
        }

        result.push(
            <div key={`line-${i}`} className="leading-relaxed">
                {tokens.length > 0 ? tokens : ' '}
            </div>
        );
    }

    return result;
}
