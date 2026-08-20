/**
 * useDbtCommands - Hook for dbt command execution
 * 
 * Extracted from page.tsx to separate concerns
 */

import { useState, useCallback } from 'react';
import { dbtApi, type DbtPreviewResponse, type DbtLineageResponse } from '@/lib/api';

export interface QueryResults {
    data: Record<string, unknown>[];
    columns: string[];
    rowCount?: number;
    executionTime?: number;
}

export interface LineageData {
    nodes: {
        id: string;
        name: string;
        type: string;
        schema?: string;
        position?: 'upstream' | 'current' | 'downstream';
        columns?: string[]
    }[];
    edges: { from: string; to: string }[];
}

export interface UseDbtCommandsReturn {
    // Command state
    isRunning: boolean;
    output: string[];

    // Query results
    queryResults: QueryResults;
    queryLoading: boolean;
    queryError: string | null;

    // Compiled SQL
    compiledSQL: string;
    compiledLoading: boolean;
    compiledError: string | null;

    // Lineage
    lineageData: LineageData;
    columnLineage: Record<string, { column: string; table: string; expression?: string }[]>;
    lineageLoading: boolean;
    lineageError: string | null;

    // Actions
    runCommand: (command: string) => Promise<void>;
    previewModel: (modelPath: string) => Promise<void>;
    compileModel: (modelPath: string) => Promise<void>;
    getLineage: (modelPath: string) => Promise<void>;
    cancelCommand: () => Promise<void>;
    clearOutput: () => void;
    addOutput: (lines: string[]) => void;
}

export function useDbtCommands(projectId: string): UseDbtCommandsReturn {
    // Command state
    const [isRunning, setIsRunning] = useState(false);
    const [output, setOutput] = useState<string[]>([]);

    // Query results
    const [queryResults, setQueryResults] = useState<QueryResults>({ data: [], columns: [] });
    const [queryLoading, setQueryLoading] = useState(false);
    const [queryError, setQueryError] = useState<string | null>(null);

    // Compiled SQL
    const [compiledSQL, setCompiledSQL] = useState('');
    const [compiledLoading, setCompiledLoading] = useState(false);
    const [compiledError, setCompiledError] = useState<string | null>(null);

    // Lineage
    const [lineageData, setLineageData] = useState<LineageData>({ nodes: [], edges: [] });
    const [columnLineage, setColumnLineage] = useState<Record<string, { column: string; table: string; expression?: string }[]>>({});
    const [lineageLoading, setLineageLoading] = useState(false);
    const [lineageError, setLineageError] = useState<string | null>(null);

    const addOutput = useCallback((lines: string[]) => {
        setOutput(prev => [...prev, ...lines]);
    }, []);

    const clearOutput = useCallback(() => {
        setOutput([]);
    }, []);

    const runCommand = useCallback(async (command: string) => {
        setIsRunning(true);
        addOutput([`$ dbt ${command}`, 'Running...']);

        try {
            const data = await dbtApi.runCommand(projectId, command);

            if (data.success) {
                const outputLines = (data.stdout || 'Command completed successfully')
                    .split('\n')
                    .filter((line: string) => line.trim() !== '');
                addOutput(outputLines);
            } else {
                const errorLines: string[] = [];
                if (data.stderr) {
                    errorLines.push('--- STDERR ---');
                    errorLines.push(...data.stderr.split('\n').filter((line: string) => line.trim() !== ''));
                }
                if (data.stdout) {
                    errorLines.push('--- STDOUT ---');
                    errorLines.push(...data.stdout.split('\n').filter((line: string) => line.trim() !== ''));
                }
                if (errorLines.length === 0) errorLines.push('Command failed with unknown error');
                addOutput(errorLines);
            }
        } catch (err) {
            const error = err as Error;
            addOutput(['Error: Cannot reach dbt-runner API', error.message || 'Network error']);
        } finally {
            setIsRunning(false);
        }
    }, [projectId, addOutput]);

    const previewModel = useCallback(async (modelPath: string) => {
        setQueryLoading(true);
        setQueryError(null);
        const modelName = modelPath.split('/').pop()?.replace('.sql', '') || '';
        addOutput([`$ dbt show --select ${modelName}`]);

        try {
            const data: DbtPreviewResponse = await dbtApi.preview(projectId, modelPath);

            if (data.success) {
                setQueryResults({
                    data: data.data,
                    columns: data.columns,
                    rowCount: data.row_count,
                    executionTime: data.execution_time,
                });
                addOutput([`✅ Preview completed: ${data.row_count} rows in ${data.execution_time?.toFixed(2)}s`]);
            } else {
                setQueryError(data.error || 'Preview failed');
                addOutput([`❌ Preview failed: ${data.error}`]);
            }
        } catch (err) {
            const error = err as Error;
            setQueryError(error.message);
            addOutput([`❌ Error: ${error.message}`]);
        } finally {
            setQueryLoading(false);
        }
    }, [projectId, addOutput]);

    const compileModel = useCallback(async (modelPath: string) => {
        setCompiledLoading(true);
        setCompiledError(null);
        const modelName = modelPath.split('/').pop()?.replace('.sql', '') || '';
        addOutput([`$ dbt compile --select ${modelName}`]);

        try {
            const data = await dbtApi.compile(projectId, modelPath);

            if (data.success) {
                setCompiledSQL(data.compiled_sql);
                addOutput([`✅ Compile completed for ${data.model}`]);
            } else {
                setCompiledError(data.error || 'Compile failed');
                addOutput([`❌ Compile failed: ${data.error}`]);
            }
        } catch (err) {
            const error = err as Error;
            setCompiledError(error.message);
            addOutput([`❌ Error: ${error.message}`]);
        } finally {
            setCompiledLoading(false);
        }
    }, [projectId, addOutput]);

    const getLineage = useCallback(async (modelPath: string) => {
        setLineageLoading(true);
        setLineageError(null);

        try {
            const data: DbtLineageResponse = await dbtApi.getLineage(projectId, modelPath);

            if (data.success) {
                // Cast position to expected union type
                const nodes = (data.table_lineage?.nodes || []).map(node => ({
                    ...node,
                    position: node.position as 'upstream' | 'current' | 'downstream' | undefined,
                }));
                setLineageData({
                    nodes,
                    edges: data.table_lineage?.edges || [],
                });
                setColumnLineage(data.column_lineage || {});
            } else {
                setLineageError(data.error || 'Failed to load lineage');
            }
        } catch (err) {
            const error = err as Error;
            setLineageError(error.message);
        } finally {
            setLineageLoading(false);
        }
    }, [projectId]);

    const cancelCommand = useCallback(async () => {
        try {
            const { getDbtRunnerUrl } = await import('@/lib/api/client');
            const response = await fetch(`${getDbtRunnerUrl()}/process/cancel?project_id=${projectId}`, {
                method: 'POST',
            });
            const data = await response.json();
            if (data.success) {
                addOutput(['^C', '⚠️ Command cancelled by user']);
            }
            setIsRunning(false);
        } catch (err) {
            console.error('Failed to cancel command:', err);
        }
    }, [projectId, addOutput]);

    return {
        isRunning,
        output,
        queryResults,
        queryLoading,
        queryError,
        compiledSQL,
        compiledLoading,
        compiledError,
        lineageData,
        columnLineage,
        lineageLoading,
        lineageError,
        runCommand,
        previewModel,
        compileModel,
        getLineage,
        cancelCommand,
        clearOutput,
        addOutput,
    };
}
