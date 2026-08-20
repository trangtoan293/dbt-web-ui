'use client';

import { useCallback, useEffect, useState } from 'react';
import { dbtApi, type DbtIntellisenseResponse } from '@/lib/api/dbt';

export interface UseDbtIntellisenseReturn {
    metadata: DbtIntellisenseResponse | null;
    loading: boolean;
    error: string | null;
    refresh: () => Promise<DbtIntellisenseResponse | null>;
}

export function useDbtIntellisense(projectId: string): UseDbtIntellisenseReturn {
    const [metadata, setMetadata] = useState<DbtIntellisenseResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!projectId) return null;
        setLoading(true);
        setError(null);
        try {
            const data = await dbtApi.getIntellisense(projectId);
            setMetadata(data);
            return data;
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load dbt metadata';
            setError(message);
            return null;
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return { metadata, loading, error, refresh };
}
