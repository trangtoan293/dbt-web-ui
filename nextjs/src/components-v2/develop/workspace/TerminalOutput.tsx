'use client';

import React, { useMemo, useRef, useEffect } from 'react';
import {
    CheckCircle,
    XCircle,
    AlertTriangle,
    Info,
    Loader2,
    Package,
    GitBranch,
    Database,
    FileCode
} from 'lucide-react';

interface TerminalOutputProps {
    lines: string[];
    emptyMessage?: React.ReactNode;
}

// ANSI color code mappings - Light theme compatible
const ANSI_COLORS: Record<string, string> = {
    '30': 'text-[#242424]',
    '31': 'text-[#D32F2F]',
    '32': 'text-[#038387]',
    '33': 'text-[#B7791F]',
    '34': 'text-[#0078D4]',
    '35': 'text-[#6B69D6]',
    '36': 'text-[#038387]',
    '37': 'text-[#616161]',
    '90': 'text-[#A0A0A0]',
    '91': 'text-[#E53935]',
    '92': 'text-[#43A047]',
    '93': 'text-[#F9A825]',
    '94': 'text-[#1E88E5]',
    '95': 'text-[#8E24AA]',
    '96': 'text-[#00ACC1]',
    '97': 'text-[#242424]',
};

// Background colors for light theme
const ANSI_BG_COLORS: Record<string, string> = {
    '40': 'bg-[#F3F2F1]',
    '41': 'bg-[#FFEBEE]',
    '42': 'bg-[#E8F5E9]',
    '43': 'bg-[#FFF8E1]',
    '44': 'bg-[#E3F2FD]',
    '45': 'bg-[#F3E5F5]',
    '46': 'bg-[#E0F7FA]',
    '47': 'bg-[#E6E6E6]',
};

// Log prefix patterns and their icons/styles
const LOG_PREFIXES = [
    { pattern: /^\[SUCCESS\]\s*/, icon: CheckCircle, color: 'text-[#038387]', iconColor: '#038387' },
    { pattern: /^\[COMPLETE\]\s*/, icon: CheckCircle, color: 'text-[#038387]', iconColor: '#038387' },
    { pattern: /^\[ERROR\]\s*/, icon: XCircle, color: 'text-[#D32F2F]', iconColor: '#D32F2F' },
    { pattern: /^\[FAILED\]\s*/, icon: XCircle, color: 'text-[#D32F2F]', iconColor: '#D32F2F' },
    { pattern: /^\[WARNING\]\s*/, icon: AlertTriangle, color: 'text-[#B7791F]', iconColor: '#B7791F' },
    { pattern: /^\[INFO\]\s*/, icon: Info, color: 'text-[#0078D4]', iconColor: '#0078D4' },
    { pattern: /^\[RUNNING\]\s*/, icon: Loader2, color: 'text-[#0078D4]', iconColor: '#0078D4', animate: true },
    { pattern: /^\[GIT\]\s*/, icon: GitBranch, color: 'text-[#6B69D6]', iconColor: '#6B69D6' },
    { pattern: /^\[DBT\]\s*/, icon: Database, color: 'text-[#FF694B]', iconColor: '#FF694B' },
    { pattern: /^\[FILE\]\s*/, icon: FileCode, color: 'text-[#038387]', iconColor: '#038387' },
    { pattern: /^\[PACKAGE\]\s*/, icon: Package, color: 'text-[#616161]', iconColor: '#616161' },
];

// Emoji replacements with icons
const EMOJI_REPLACEMENTS = [
    { emoji: '✅', icon: CheckCircle, color: '#038387' },
    { emoji: '❌', icon: XCircle, color: '#D32F2F' },
    { emoji: '⚠️', icon: AlertTriangle, color: '#B7791F' },
    { emoji: '📦', icon: Package, color: '#616161' },
    { emoji: '🔄', icon: Loader2, color: '#0078D4', animate: true },
    { emoji: '📝', icon: FileCode, color: '#038387' },
];

// dbt-specific patterns for syntax highlighting
const DBT_PATTERNS = {
    // Success patterns
    success: /(\bOK\b|\bPASS\b|\bSUCCESS\b|✓|✔|Completed successfully|1 of 1 OK)/gi,
    // Error patterns  
    error: /(\bERROR\b|\bFAIL\b|\bFAILED\b|\bFATAL\b|✗|✘|Compilation Error|Runtime Error|Database Error)/gi,
    // Warning patterns
    warning: /(\bWARN\b|\bWARNING\b|\bSKIP\b|\bSKIPPED\b|⚠)/gi,
    // Info patterns
    info: /(\bINFO\b|\bDEBUG\b|\bRUNNING\b|\bStarting\b|\bFinished\b)/gi,
    // Timing info
    timing: /(\[\d+:\d+:\d+\]|\d+\.\d+s|\d+ seconds?)/gi,
    // File paths
    path: /((?:models|seeds|snapshots|tests|macros)\/[\w/.-]+\.(?:sql|yml|yaml))/gi,
    // Numbers/stats
    stats: /(\d+ (?:pass|passed|fail|failed|error|errors|warn|warnings|skip|skipped|total))/gi,
    // Command prompt
    prompt: /^(\$\s+.+)$/gm,
};

interface StyledSegment {
    text: string;
    className: string;
}

function parseAnsiCodes(text: string): StyledSegment[] {
    const segments: StyledSegment[] = [];
    const ansiRegex = /\x1b\[([0-9;]+)m/g;

    let lastIndex = 0;
    let currentClasses: string[] = ['text-[#242424]'];
    let match;

    const strippedParts: { text: string; classes: string[] }[] = [];

    while ((match = ansiRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            strippedParts.push({
                text: text.slice(lastIndex, match.index),
                classes: [...currentClasses]
            });
        }

        const codes = match[1].split(';');
        for (const code of codes) {
            if (code === '0') {
                currentClasses = ['text-[#242424]'];
            } else if (code === '1') {
                currentClasses.push('font-bold');
            } else if (code === '3') {
                currentClasses.push('italic');
            } else if (code === '4') {
                currentClasses.push('underline');
            } else if (ANSI_COLORS[code]) {
                currentClasses = currentClasses.filter(c => !c.startsWith('text-'));
                currentClasses.push(ANSI_COLORS[code]);
            } else if (ANSI_BG_COLORS[code]) {
                currentClasses = currentClasses.filter(c => !c.startsWith('bg-'));
                currentClasses.push(ANSI_BG_COLORS[code]);
            }
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        strippedParts.push({
            text: text.slice(lastIndex),
            classes: [...currentClasses]
        });
    }

    if (strippedParts.length === 0) {
        return [{ text, className: 'text-[#242424]' }];
    }

    for (const part of strippedParts) {
        if (part.text) {
            segments.push({
                text: part.text,
                className: part.classes.join(' ')
            });
        }
    }

    return segments;
}

function renderLineWithIcons(line: string): React.ReactNode {
    // Check for log prefixes first
    for (const prefix of LOG_PREFIXES) {
        if (prefix.pattern.test(line)) {
            const IconComponent = prefix.icon;
            const text = line.replace(prefix.pattern, '');
            return (
                <span className={`flex items-start gap-1.5 ${prefix.color}`}>
                    <IconComponent
                        className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${prefix.animate ? 'animate-spin' : ''}`}
                        style={{ color: prefix.iconColor }}
                    />
                    <span>{applyDbtHighlighting(text)}</span>
                </span>
            );
        }
    }

    // Check for emoji and replace with icons
    for (const replacement of EMOJI_REPLACEMENTS) {
        if (line.includes(replacement.emoji)) {
            const IconComponent = replacement.icon;
            const parts = line.split(replacement.emoji);
            return (
                <span className="flex items-start gap-1.5">
                    <IconComponent
                        className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${replacement.animate ? 'animate-spin' : ''}`}
                        style={{ color: replacement.color }}
                    />
                    <span>{applyDbtHighlighting(parts.join('').trim())}</span>
                </span>
            );
        }
    }

    // Default rendering
    return applyDbtHighlighting(line);
}

function applyDbtHighlighting(text: string): React.ReactNode[] {
    const ansiSegments = parseAnsiCodes(text);
    const result: React.ReactNode[] = [];
    let keyIndex = 0;

    for (const segment of ansiSegments) {
        const processedText = segment.text;
        const parts: React.ReactNode[] = [];

        if (processedText.startsWith('$ ')) {
            parts.push(
                <span key={keyIndex++} className="text-[#038387] font-semibold">
                    {processedText}
                </span>
            );
            result.push(...parts);
            continue;
        }

        if (processedText === 'Running...') {
            parts.push(
                <span key={keyIndex++} className="text-[#0078D4] animate-pulse">
                    {processedText}
                </span>
            );
            result.push(...parts);
            continue;
        }

        let lastIdx = 0;
        const highlights: { start: number; end: number; className: string; text: string }[] = [];

        const patterns: [RegExp, string][] = [
            [DBT_PATTERNS.success, 'text-[#038387] font-semibold'],
            [DBT_PATTERNS.error, 'text-[#D32F2F] font-semibold'],
            [DBT_PATTERNS.warning, 'text-[#B7791F] font-semibold'],
            [DBT_PATTERNS.timing, 'text-[#A0A0A0]'],
            [DBT_PATTERNS.path, 'text-[#0078D4]'],
            [DBT_PATTERNS.stats, 'text-[#6B69D6]'],
        ];

        for (const [pattern, className] of patterns) {
            const regex = new RegExp(pattern.source, pattern.flags);
            let match;
            while ((match = regex.exec(processedText)) !== null) {
                highlights.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    className,
                    text: match[0]
                });
            }
        }

        highlights.sort((a, b) => a.start - b.start);

        const filteredHighlights: typeof highlights = [];
        for (const h of highlights) {
            const overlaps = filteredHighlights.some(
                existing => h.start < existing.end && h.end > existing.start
            );
            if (!overlaps) {
                filteredHighlights.push(h);
            }
        }

        if (filteredHighlights.length === 0) {
            parts.push(
                <span key={keyIndex++} className={segment.className}>
                    {processedText}
                </span>
            );
        } else {
            for (const h of filteredHighlights) {
                if (h.start > lastIdx) {
                    parts.push(
                        <span key={keyIndex++} className={segment.className}>
                            {processedText.slice(lastIdx, h.start)}
                        </span>
                    );
                }
                parts.push(
                    <span key={keyIndex++} className={h.className}>
                        {h.text}
                    </span>
                );
                lastIdx = h.end;
            }
            if (lastIdx < processedText.length) {
                parts.push(
                    <span key={keyIndex++} className={segment.className}>
                        {processedText.slice(lastIdx)}
                    </span>
                );
            }
        }

        result.push(...parts);
    }

    return result;
}

export default function TerminalOutput({ lines, emptyMessage }: TerminalOutputProps) {
    const bottomRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const isAtBottomRef = useRef(true);

    const renderedLines = useMemo(() => {
        return lines.map((line, lineIndex) => (
            <div key={lineIndex} className="leading-relaxed">
                {renderLineWithIcons(line)}
            </div>
        ));
    }, [lines]);

    useEffect(() => {
        const el = containerRef.current?.parentElement;
        if (!el) return;
        const handleScroll = () => {
            const threshold = 40;
            isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
        };
        el.addEventListener('scroll', handleScroll);
        return () => el.removeEventListener('scroll', handleScroll);
    }, []);

    useEffect(() => {
        if (isAtBottomRef.current) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [lines]);

    if (lines.length === 0) {
        if (emptyMessage !== undefined) {
            return <div className="text-[#616161] italic">{emptyMessage}</div>;
        }
        return (
            <div className="text-[#616161] italic">
                Terminal ready. Type a command below...
                <div className="mt-2 text-xs">
                    <span className="text-[#0078D4]">Commands:</span>{' '}
                    <span className="text-[#038387]">dbt run</span>,{' '}
                    <span className="text-[#038387]">git status</span>,{' '}
                    <span className="text-[#038387]">help</span>
                </div>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className="space-y-0.5"
        >
            {renderedLines}
            <div ref={bottomRef} />
        </div>
    );
}
