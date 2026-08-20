/**
 * useFileTree - Hook for file tree state and operations
 * 
 * Extracted from page.tsx to separate concerns
 */

import { useState, useCallback } from 'react';
import { filesApi, type FileNode as ApiFileNode } from '@/lib/api';

export interface FileNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: FileNode[];
}

export interface UseFileTreeReturn {
    fileTree: FileNode[];
    expandedPaths: Set<string>;
    loadedChildren: Record<string, FileNode[]>;
    loading: boolean;
    error: string | null;
    loadFileTree: () => Promise<void>;
    loadFolderChildren: (path: string) => Promise<FileNode[]>;
    toggleExpand: (path: string) => void;
    createFile: (path: string, type: 'file' | 'directory') => Promise<boolean>;
    deleteFile: (path: string) => Promise<boolean>;
}

function transformToFileNode(item: ApiFileNode): FileNode {
    return {
        name: item.name,
        path: item.path,
        type: item.type === 'folder' ? 'directory' : 'file',
        children: item.type === 'folder' ? [] : undefined,
    };
}

export function useFileTree(projectId: string): UseFileTreeReturn {
    const [fileTree, setFileTree] = useState<FileNode[]>([]);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [loadedChildren, setLoadedChildren] = useState<Record<string, FileNode[]>>({});
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadFileTree = useCallback(async () => {
        if (!projectId) return;

        setLoading(true);
        setError(null);

        try {
            const data = await filesApi.list(projectId);
            const tree = (data.items || []).map(transformToFileNode);
            setFileTree(tree);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load file tree';
            setError(message);
            console.error('Error loading file tree:', err);
            setFileTree([]);
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    const loadFolderChildren = useCallback(async (path: string): Promise<FileNode[]> => {
        try {
            const data = await filesApi.list(projectId, path);
            const children = (data.items || []).map(transformToFileNode);
            setLoadedChildren(prev => ({ ...prev, [path]: children }));
            return children;
        } catch (err) {
            console.error('Error loading folder:', err);
            return [];
        }
    }, [projectId]);

    const toggleExpand = useCallback((path: string) => {
        setExpandedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    }, []);

    const createFile = useCallback(async (path: string, type: 'file' | 'directory'): Promise<boolean> => {
        try {
            await filesApi.create(projectId, { path, file_type: type });
            await loadFileTree(); // Refresh tree
            return true;
        } catch (err) {
            console.error('Error creating file:', err);
            return false;
        }
    }, [projectId, loadFileTree]);

    const deleteFile = useCallback(async (path: string): Promise<boolean> => {
        try {
            await filesApi.delete(projectId, path);
            await loadFileTree(); // Refresh tree
            return true;
        } catch (err) {
            console.error('Error deleting file:', err);
            return false;
        }
    }, [projectId, loadFileTree]);

    return {
        fileTree,
        expandedPaths,
        loadedChildren,
        loading,
        error,
        loadFileTree,
        loadFolderChildren,
        toggleExpand,
        createFile,
        deleteFile,
    };
}
