'use client';

import dynamic from 'next/dynamic';
import { useCallback, useRef } from 'react';
import type { editor, languages } from 'monaco-editor';
import type { DbtIntellisenseResponse } from '@/lib/api/dbt';
import { getColumnQualifier, resolveColumnsForQualifier } from '@/lib/dbt/intellisense';

const Editor = dynamic(
    () => import('@/lib/monaco-loader').then(({ loadMonacoEditor }) => loadMonacoEditor()),
    { ssr: false }
);

// Global flag to ensure completion provider is registered only once
let completionProviderRegistered = false;
let definitionProviderRegistered = false;
let currentIntellisenseMetadata: DbtIntellisenseResponse | null = null;
let currentOpenDefinition: ((path: string) => void) | undefined;

interface CodeEditorProps {
    value: string;
    onChange: (value: string | undefined) => void;
    language?: string;
    readOnly?: boolean;
    height?: string;
    theme?: 'light' | 'dark';
    onSave?: () => void;
    onPreview?: () => void;
    onRun?: () => void;
    onNewFile?: () => void;
    onCloseFile?: () => void;
    fileName?: string; // Current file name/path for format detection
    /**
     * Format the active file. Supplied by the workspace so the toolbar button
     * and Shift+Alt+F run the same code path - which tries the server-side
     * sqlglot formatter and falls back to formatSQL below. Without it this
     * editor formats locally on its own.
     */
    onFormat?: () => void;
    dbtIntellisense?: DbtIntellisenseResponse | null;
    onOpenDefinition?: (path: string) => void;
}

// dbt Jinja keywords for autocomplete
const DBT_JINJA_KEYWORDS = [
    // dbt functions
    { label: 'ref', insertText: "ref('${1:model_name}')", documentation: 'Reference another model' },
    { label: 'source', insertText: "source('${1:source_name}', '${2:table_name}')", documentation: 'Reference a source table' },
    { label: 'config', insertText: "config(\n  materialized='${1|table,view,incremental,ephemeral|}',\n  ${2}\n)", documentation: 'Model configuration' },
    { label: 'var', insertText: "var('${1:variable_name}')", documentation: 'Access a variable' },
    { label: 'env_var', insertText: "env_var('${1:ENV_VAR_NAME}')", documentation: 'Access environment variable' },
    // Jinja control structures
    { label: 'if', insertText: "{% if ${1:condition} %}\n  ${2}\n{% endif %}", documentation: 'Jinja if statement' },
    { label: 'for', insertText: "{% for ${1:item} in ${2:items} %}\n  ${3}\n{% endfor %}", documentation: 'Jinja for loop' },
    { label: 'set', insertText: "{% set ${1:variable} = ${2:value} %}", documentation: 'Set a variable' },
    { label: 'macro', insertText: "{% macro ${1:name}(${2:args}) %}\n  ${3}\n{% endmacro %}", documentation: 'Define a macro' },
    // dbt macros
    { label: 'dbt_utils.star', insertText: "{{ dbt_utils.star(ref('${1:model}')) }}", documentation: 'Select all columns' },
    { label: 'dbt_utils.surrogate_key', insertText: "{{ dbt_utils.surrogate_key(['${1:column1}', '${2:column2}']) }}", documentation: 'Generate surrogate key' },
    { label: 'dbt_utils.pivot', insertText: "{{ dbt_utils.pivot('${1:column}', ${2:values}) }}", documentation: 'Pivot values' },
    { label: 'dbt_utils.unpivot', insertText: "{{ dbt_utils.unpivot(ref('${1:model}'), ${2:columns}) }}", documentation: 'Unpivot columns' },
    // Incremental
    { label: 'is_incremental', insertText: "{% if is_incremental() %}\n  ${1:-- incremental logic}\n{% endif %}", documentation: 'Check if incremental run' },
    { label: 'this', insertText: "{{ this }}", documentation: 'Reference current model' },
];

// SQL keywords for autocomplete
const SQL_KEYWORDS = [
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
    'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL',
    'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
    'WITH', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
    'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN',
    'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE', 'COALESCE', 'NULLIF', 'CAST',
    'DATE', 'TIMESTAMP', 'INTERVAL', 'EXTRACT', 'DATE_TRUNC',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'OVER', 'PARTITION BY',
];

type CompletionContext =
    | { type: 'ref' }
    | { type: 'source-name' }
    | { type: 'source-table'; sourceName: string }
    | { type: 'doc' }
    | { type: 'macro' }
    | { type: 'default' };

function getCompletionContext(textBeforeCursor: string): CompletionContext {
    if (/ref\(\s*['"][^'"]*$/.test(textBeforeCursor)) return { type: 'ref' };
    const sourceTableMatch = textBeforeCursor.match(/source\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*$/);
    if (sourceTableMatch) return { type: 'source-table', sourceName: sourceTableMatch[1] };
    if (/source\(\s*['"][^'"]*$/.test(textBeforeCursor)) return { type: 'source-name' };
    if (/doc\(\s*['"][^'"]*$/.test(textBeforeCursor)) return { type: 'doc' };
    if (/\{\{\s*[\w.]*$/.test(textBeforeCursor)) return { type: 'macro' };
    return { type: 'default' };
}

function findRefAtPosition(model: editor.ITextModel, position: { lineNumber: number; column: number }) {
    const line = model.getLineContent(position.lineNumber);
    const regex = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
        const startColumn = match.index + 1;
        const endColumn = match.index + match[0].length + 1;
        if (position.column >= startColumn && position.column <= endColumn) {
            return match[1];
        }
    }
    return null;
}

// Simple SQL formatter for dbt projects
function formatSQL(sql: string): string {
    // Preserve Jinja blocks
    const jinjaBlocks: string[] = [];
    let formatted = sql.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g, (match) => {
        jinjaBlocks.push(match);
        return `__JINJA_BLOCK_${jinjaBlocks.length - 1}__`;
    });

    // Preserve SQL comments (both single-line -- and multi-line /* */)
    const comments: string[] = [];
    formatted = formatted.replace(/(--[^\n]*)|\/\*[\s\S]*?\*\//g, (match) => {
        comments.push(match);
        return `__COMMENT_${comments.length - 1}__`;
    });

    // Preserve string literals
    const strings: string[] = [];
    formatted = formatted.replace(/('(?:[^'\\]|\\.)*')|("(?:[^"\\]|\\.)*")/g, (match) => {
        strings.push(match);
        return `__STRING_${strings.length - 1}__`;
    });

    // Basic SQL formatting - now safe to format without touching comments/strings
    const keywords = [
        'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
        'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'AND', 'OR', 'GROUP BY', 'ORDER BY',
        'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'WITH', 'AS', 'CASE',
        'WHEN', 'THEN', 'ELSE', 'END', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET',
        'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE'
    ];

    // Uppercase keywords (only actual SQL keywords, not in comments/strings)
    for (const keyword of keywords) {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        formatted = formatted.replace(regex, keyword);
    }

    // Add newlines before major keywords
    const newlineKeywords = [
        'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
        'FULL OUTER JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'UNION',
        'WITH'
    ];

    for (const keyword of newlineKeywords) {
        // Don't add newline if already at start of line or after comment
        const regex = new RegExp(`(?<!^|\\n|__COMMENT_\\d+__)\\s*\\b(${keyword})\\b`, 'gi');
        formatted = formatted.replace(regex, `\n$1`);
    }

    // Process lines for indentation
    const lines = formatted.split('\n');
    const indentedLines: string[] = [];
    let indentLevel = 0;
    const indentSize = 2;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check if line is a comment placeholder - preserve as is
        const isComment = /^__COMMENT_\d+__/.test(trimmed);

        if (!isComment) {
            // Decrease indent for certain keywords
            if (/^(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|UNION|END|ELSE|\))/i.test(trimmed)) {
                indentLevel = Math.max(0, indentLevel - 1);
            }
        }

        // Add indentation
        const indent = ' '.repeat(indentLevel * indentSize);
        indentedLines.push(indent + trimmed);

        if (!isComment) {
            // Increase indent after certain keywords
            if (/^(SELECT|WITH|CASE|WHEN|\()/i.test(trimmed) && !/\)$/i.test(trimmed)) {
                indentLevel++;
            }
        }
    }

    formatted = indentedLines.join('\n');

    // Restore string literals first
    formatted = formatted.replace(/__STRING_(\d+)__/g, (_, index) => {
        return strings[parseInt(index)];
    });

    // Restore comments
    formatted = formatted.replace(/__COMMENT_(\d+)__/g, (_, index) => {
        return comments[parseInt(index)];
    });

    // Restore Jinja blocks
    formatted = formatted.replace(/__JINJA_BLOCK_(\d+)__/g, (_, index) => {
        return jinjaBlocks[parseInt(index)];
    });

    // Clean up extra whitespace
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    formatted = formatted.trim();

    return formatted;
}

// Helper to check if file can be formatted (SQL only)
function canFormatFile(filePath: string): boolean {
    if (!filePath) return false;
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'sql';
}

// Format file based on extension (SQL only)
function formatFile(filePath: string, content: string): string {
    if (!filePath) return content;

    const ext = filePath.split('.').pop()?.toLowerCase();

    if (ext === 'sql') {
        return formatSQL(content);
    }

    return content; // No formatting for other file types
}


export default function CodeEditor({
    value,
    onChange,
    language = 'sql',
    readOnly = false,
    height = '100%',
    theme = 'light',
    onSave,
    onPreview,
    onRun,
    onNewFile,
    onCloseFile,
    fileName,
    onFormat,
    dbtIntellisense,
    onOpenDefinition,
}: CodeEditorProps) {
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<typeof import('monaco-editor') | null>(null);

    // Use refs to always have latest callbacks (avoids stale closure in Monaco actions)
    const onSaveRef = useRef(onSave);
    const onPreviewRef = useRef(onPreview);
    const onRunRef = useRef(onRun);
    const onNewFileRef = useRef(onNewFile);
    const onCloseFileRef = useRef(onCloseFile);
    const fileNameRef = useRef(fileName);
    const onFormatRef = useRef(onFormat);

    // Keep refs updated
    onSaveRef.current = onSave;
    onPreviewRef.current = onPreview;
    onRunRef.current = onRun;
    onNewFileRef.current = onNewFile;
    onCloseFileRef.current = onCloseFile;
    fileNameRef.current = fileName;
    onFormatRef.current = onFormat;
    currentIntellisenseMetadata = dbtIntellisense || null;
    currentOpenDefinition = onOpenDefinition;

    // Detect language from file extension (can be passed)
    const getLanguage = (lang: string) => {
        const mapping: Record<string, string> = {
            sql: 'sql',
            yml: 'yaml',
            yaml: 'yaml',
            md: 'markdown',
            json: 'json',
            py: 'python',
            csv: 'plaintext',
            log: 'plaintext',
            logs: 'plaintext',
            dbtignore: 'plaintext',
            shell: 'shell',
            sh: 'shell',
            bash: 'shell',
        };
        return mapping[lang] || 'sql';
    };

    const handleEditorDidMount = useCallback((editor: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        // Register dbt/Jinja completions for SQL files - only once globally
        if (!completionProviderRegistered) {
            completionProviderRegistered = true;

            monaco.languages.registerCompletionItemProvider('sql', {
                provideCompletionItems: (model, position) => {
                    const word = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: word.endColumn,
                    };

                    const suggestions: languages.CompletionItem[] = [];
                    const metadata = currentIntellisenseMetadata;
                    const textBeforeCursor = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
                    const context = getCompletionContext(textBeforeCursor);

                    if (metadata?.status === 'ready') {
                        const qualifier = getColumnQualifier(textBeforeCursor);
                        if (qualifier) {
                            const columns = resolveColumnsForQualifier(model.getValue(), qualifier, metadata);
                            if (columns.length > 0) {
                                return {
                                    suggestions: columns.map((column) => ({
                                        label: column.name,
                                        kind: monaco.languages.CompletionItemKind.Field,
                                        insertText: column.name,
                                        documentation: column.description || undefined,
                                        detail: column.data_type || `${qualifier} column`,
                                        range,
                                    })),
                                };
                            }
                        }

                        if (context.type === 'ref') {
                            return {
                                suggestions: metadata.models.map((item) => ({
                                    label: item.name,
                                    kind: monaco.languages.CompletionItemKind.Module,
                                    insertText: item.name,
                                    documentation: item.description || item.path,
                                    detail: item.path,
                                    range,
                                })),
                            };
                        }

                        if (context.type === 'source-name') {
                            const sourceNames = Array.from(new Set(metadata.sources.map((item) => item.source_name).filter(Boolean))).sort();
                            return {
                                suggestions: sourceNames.map((sourceName) => ({
                                    label: sourceName,
                                    kind: monaco.languages.CompletionItemKind.Module,
                                    insertText: sourceName,
                                    detail: 'dbt source',
                                    range,
                                })),
                            };
                        }

                        if (context.type === 'source-table') {
                            return {
                                suggestions: metadata.sources
                                    .filter((item) => item.source_name === context.sourceName)
                                    .map((item) => ({
                                        label: item.table_name,
                                        kind: monaco.languages.CompletionItemKind.Field,
                                        insertText: item.table_name,
                                        documentation: item.description || item.path,
                                        detail: item.path,
                                        range,
                                    })),
                            };
                        }

                        if (context.type === 'doc') {
                            return {
                                suggestions: metadata.docs.map((item) => ({
                                    label: item.name,
                                    kind: monaco.languages.CompletionItemKind.Text,
                                    insertText: item.name,
                                    detail: item.path,
                                    range,
                                })),
                            };
                        }

                        if (context.type === 'macro') {
                            return {
                                suggestions: metadata.macros.map((item) => ({
                                    label: item.package_name ? `${item.package_name}.${item.name}` : item.name,
                                    kind: monaco.languages.CompletionItemKind.Function,
                                    insertText: item.name,
                                    documentation: item.description || item.path,
                                    detail: item.package_name || 'macro',
                                    range,
                                })),
                            };
                        }
                    }

                    // Add dbt Jinja suggestions
                    for (const item of DBT_JINJA_KEYWORDS) {
                        suggestions.push({
                            label: item.label,
                            kind: monaco.languages.CompletionItemKind.Function,
                            insertText: item.insertText,
                            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                            documentation: item.documentation,
                            range,
                        });
                    }

                    // Add SQL keyword suggestions
                    for (const keyword of SQL_KEYWORDS) {
                        suggestions.push({
                            label: keyword,
                            kind: monaco.languages.CompletionItemKind.Keyword,
                            insertText: keyword,
                            range,
                        });
                    }

                    return { suggestions };
                },
                triggerCharacters: ['{', '.', '(', ' ', "'", '"', ','],
            });
        }

        if (!definitionProviderRegistered) {
            definitionProviderRegistered = true;

            monaco.languages.registerDefinitionProvider('sql', {
                provideDefinition: (model, position) => {
                    const metadata = currentIntellisenseMetadata;
                    if (!metadata || metadata.status !== 'ready') return null;

                    const modelName = findRefAtPosition(model, position);
                    if (!modelName) return null;

                    const target = metadata.models.find((item) => item.name === modelName);
                    if (!target?.path) return null;

                    currentOpenDefinition?.(target.path);
                    return {
                        uri: monaco.Uri.parse(`dbt-definition:///${encodeURIComponent(target.path)}`),
                        range: new monaco.Range(1, 1, 1, 1),
                    };
                },
            });
        }

        // Add keyboard shortcut for formatting (Shift+Alt+F)
        editor.addAction({
            id: 'format-file',
            label: 'Format File',
            keybindings: [
                monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
            ],
            run: () => {
                const currentFileName = fileNameRef.current;
                if (!currentFileName || !canFormatFile(currentFileName)) return;

                // One implementation, whichever way formatting was asked for.
                if (onFormatRef.current) {
                    onFormatRef.current();
                    return;
                }

                const formatted = formatFile(currentFileName, editor.getValue());
                editor.setValue(formatted);
                onChange?.(formatted);
            },
        });

        if (onNewFileRef.current) {
            // Add keyboard shortcut for new SQL draft (Ctrl/Cmd+N)
            editor.addAction({
                id: 'new-sql-draft',
                label: 'New SQL Draft',
                keybindings: [
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyN,
                ],
                run: () => {
                    onNewFileRef.current?.();
                },
            });
        }

        if (onCloseFileRef.current) {
            editor.addAction({
                id: 'close-current-file',
                label: 'Close Current File',
                keybindings: [
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
                ],
                run: () => {
                    onCloseFileRef.current?.();
                },
            });
        }

        // Add keyboard shortcut for save (Ctrl/Cmd+S)
        editor.addAction({
            id: 'save-file',
            label: 'Save File',
            keybindings: [
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
            ],
            run: () => {
                onSaveRef.current?.();
            },
        });

        // Add keyboard shortcut for preview (Ctrl/Cmd+Enter)
        editor.addAction({
            id: 'preview-model',
            label: 'Preview Model Data',
            keybindings: [
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
            ],
            run: () => {
                onPreviewRef.current?.();
            },
        });

        // Add keyboard shortcut for run (Ctrl/Cmd+Shift+Enter)
        editor.addAction({
            id: 'run-model',
            label: 'Run Model',
            keybindings: [
                monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
            ],
            run: () => {
                onRunRef.current?.();
            },
        });
        editor.addAction({
            id: 'run-selection',
            label: 'Run Selection',
            keybindings: [
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
            ],
            run: () => onPreviewRef.current?.(),
        });
    }, [onChange]);

    // Expose format function
    const handleFormat = useCallback(() => {
        if (editorRef.current) {
            const currentValue = editorRef.current.getValue();
            const formatted = formatSQL(currentValue);
            editorRef.current.setValue(formatted);
            onChange?.(formatted);
        }
    }, [onChange]);

    // Make format function available to parent
    if (typeof window !== 'undefined') {
        (window as Window & { formatDbtSQL?: () => void }).formatDbtSQL = handleFormat;
    }

    return (
        <Editor
            height={height}
            defaultLanguage={getLanguage(language)}
            language={getLanguage(language)}
            value={value}
            onChange={onChange}
            theme={theme === 'dark' ? 'vs-dark' : 'vs-light'}
            onMount={handleEditorDidMount}
            options={{
                readOnly,
                minimap: { enabled: true, maxColumn: 80 },
                fontSize: 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
                fontLigatures: true,
                lineNumbers: readOnly ? 'off' : 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                tabSize: 2,
                insertSpaces: true,
                padding: { top: 8, bottom: 8 },
                renderLineHighlight: readOnly ? 'none' : 'all',
                folding: !readOnly,
                foldingStrategy: 'indentation',
                bracketPairColorization: { enabled: true },
                guides: {
                    bracketPairs: true,
                    indentation: true,
                },
                suggestOnTriggerCharacters: true,
                quickSuggestions: {
                    other: true,
                    comments: false,
                    strings: true,
                },
                acceptSuggestionOnEnter: 'on',
                tabCompletion: 'on',
                snippetSuggestions: 'top',
                formatOnPaste: false,
                formatOnType: false,
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                smoothScrolling: true,
                mouseWheelZoom: true,
                renderWhitespace: 'selection',
                renderControlCharacters: true,
                // SQL-specific
                wordBasedSuggestions: 'currentDocument',
            }}
        />
    );
}

// Export format functions for external use (SQL only)
export { formatSQL, canFormatFile, formatFile };
