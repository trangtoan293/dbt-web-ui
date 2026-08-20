/**
 * useEditor - Hook for editor tabs and file content management
 * 
 * Extracted from page.tsx to separate concerns
 */

import { useState, useCallback } from 'react';
import { filesApi } from '@/lib/api';

export interface OpenTab {
    path: string;
    name: string;
    content: string;
    originalContent: string;
    isDirty: boolean;
    isDraft?: boolean;
}

export interface UseEditorReturn {
    // Tabs state
    openTabs: OpenTab[];
    activeTabPath: string | null;

    // Current file
    selectedFile: string | null;
    fileContent: string;

    // Actions
    openFile: (path: string) => Promise<void>;
    closeTab: (path: string) => void;
    switchTab: (path: string) => void;
    updateContent: (content: string) => void;
    saveFile: () => Promise<boolean>;
    getFileLanguage: (path: string) => string;
}

export function useEditor(projectId: string): UseEditorReturn {
    const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
    const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [fileContent, setFileContent] = useState<string>('');

    const openFile = useCallback(async (path: string) => {
        setSelectedFile(path);
        setActiveTabPath(path);

        // Check if file is already open
        const existingTab = openTabs.find(t => t.path === path);
        if (existingTab) {
            setFileContent(existingTab.content);
            return;
        }

        // Fetch file content
        try {
            const data = await filesApi.read(projectId, path);
            const content = data.content || '';
            setFileContent(content);

            // Add new tab
            const fileName = path.split('/').pop() || path;
            setOpenTabs(prev => [...prev, {
                path,
                name: fileName,
                content,
                originalContent: content,
                isDirty: false,
            }]);
        } catch (err) {
            console.error('Error loading file:', err);
            setFileContent(`-- Error loading ${path}`);
        }
    }, [projectId, openTabs]);

    const closeTab = useCallback((path: string) => {
        const tab = openTabs.find(t => t.path === path);
        if (tab?.isDirty && !confirm('Unsaved changes. Close anyway?')) {
            return;
        }

        const newTabs = openTabs.filter(t => t.path !== path);
        setOpenTabs(newTabs);

        // If closing active tab, switch to last tab or clear
        if (activeTabPath === path) {
            if (newTabs.length > 0) {
                const lastTab = newTabs[newTabs.length - 1];
                setActiveTabPath(lastTab.path);
                setSelectedFile(lastTab.path);
                setFileContent(lastTab.content);
            } else {
                setActiveTabPath(null);
                setSelectedFile(null);
                setFileContent('');
            }
        }
    }, [openTabs, activeTabPath]);

    const switchTab = useCallback((path: string) => {
        setActiveTabPath(path);
        setSelectedFile(path);
        const tab = openTabs.find(t => t.path === path);
        if (tab) {
            setFileContent(tab.content);
        }
    }, [openTabs]);

    const updateContent = useCallback((content: string) => {
        setFileContent(content);
        // Mark tab as dirty
        setOpenTabs(prev => prev.map(t =>
            t.path === activeTabPath
                ? { ...t, content, isDirty: content !== t.originalContent }
                : t
        ));
    }, [activeTabPath]);

    const saveFile = useCallback(async (): Promise<boolean> => {
        if (!selectedFile || !fileContent) return false;

        try {
            await filesApi.save(projectId, selectedFile, fileContent);

            // Clear isDirty flag
            setOpenTabs(prev => prev.map(t =>
                t.path === selectedFile
                    ? { ...t, content: fileContent, originalContent: fileContent, isDirty: false }
                    : t
            ));
            return true;
        } catch (err) {
            console.error('Error saving file:', err);
            return false;
        }
    }, [projectId, selectedFile, fileContent]);

    const getFileLanguage = useCallback((path: string): string => {
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const languageMap: Record<string, string> = {
            sql: 'sql',
            yml: 'yaml',
            yaml: 'yaml',
            md: 'markdown',
            py: 'python',
            json: 'json',
            csv: 'plaintext',
        };
        return languageMap[ext] || 'plaintext';
    }, []);

    return {
        openTabs,
        activeTabPath,
        selectedFile,
        fileContent,
        openFile,
        closeTab,
        switchTab,
        updateContent,
        saveFile,
        getFileLanguage,
    };
}
