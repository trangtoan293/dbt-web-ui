'use client';

/**
 * ProjectContext - Provides project-level shared state
 * 
 * This context shares state that needs to be accessed by multiple components:
 * - Project data
 * - dbt command state
 * - Terminal output
 */

import React, { createContext, useContext, ReactNode, useEffect } from 'react';
import { useProject, useFileTree, useDbtCommands, useEditor } from '@/lib/hooks';
import type { DbtProject, UseProjectReturn } from '@/lib/hooks/useProject';
import type { UseFileTreeReturn } from '@/lib/hooks/useFileTree';
import type { UseDbtCommandsReturn } from '@/lib/hooks/useDbtCommands';
import type { UseEditorReturn } from '@/lib/hooks/useEditor';

interface ProjectContextValue {
    // Project
    project: UseProjectReturn;

    // File tree
    fileTree: UseFileTreeReturn;

    // Editor
    editor: UseEditorReturn;

    // dbt commands
    dbt: UseDbtCommandsReturn;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

interface ProjectProviderProps {
    projectId: string;
    children: ReactNode;
}

export function ProjectProvider({ projectId, children }: ProjectProviderProps) {
    const project = useProject(projectId);
    const fileTree = useFileTree(projectId);
    const editor = useEditor(projectId);
    const dbt = useDbtCommands(projectId);

    // Load file tree on mount
    useEffect(() => {
        fileTree.loadFileTree();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    const value: ProjectContextValue = {
        project,
        fileTree,
        editor,
        dbt,
    };

    return (
        <ProjectContext.Provider value={value}>
            {children}
        </ProjectContext.Provider>
    );
}

export function useProjectContext(): ProjectContextValue {
    const context = useContext(ProjectContext);
    if (!context) {
        throw new Error('useProjectContext must be used within a ProjectProvider');
    }
    return context;
}

// Re-export types for convenience
export type { DbtProject };
