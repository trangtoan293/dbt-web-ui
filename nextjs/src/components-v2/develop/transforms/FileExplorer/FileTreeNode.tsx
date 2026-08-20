'use client';

/**
 * FileTreeNode - Recursive component for rendering file tree nodes
 * Features: Git status indicators (M, U, A, D) with VS Code-like colors,
 *           Drag and Drop support, Horizontal scroll
 */

import React, { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { type FileNode } from '@/lib/hooks';
import InlineInput from './InlineInput';
import type { InlineEditState } from './index';
import { FileTypeIcon } from './fileIconTheme';

interface GitChange {
    status: string;
    path: string;
}

interface FileTreeNodeProps {
    node: FileNode;
    depth?: number;
    selectedPaths: Set<string>;
    expandedPaths: Set<string>;
    loadedChildren: Record<string, FileNode[]>;
    gitChanges?: GitChange[];
    draggedPath: string | null;
    inlineEdit?: InlineEditState | null;
    onNodeClick: (node: FileNode, e: React.MouseEvent) => void;
    onToggleExpand: (path: string) => void;
    onLoadChildren: (path: string) => Promise<FileNode[]>;
    onContextMenu: (e: React.MouseEvent, path: string, type: 'file' | 'directory') => void;
    onDragStart: (path: string) => void;
    onDragEnd: () => void;
    onDrop: (destPath: string, sourcePath?: string) => void;
    onOsFilesDrop: (destPath: string, dataTransfer: DataTransfer) => void;
    onInlineCreate?: (parentPath: string, name: string, type: 'file' | 'directory') => void;
    onInlineRename?: (oldPath: string, newName: string) => void;
    onInlineCancel?: () => void;
}

// Git status colors matching VS Code
const getGitStatusColor = (status: string): string => {
    switch (status) {
        case 'M':  // Modified
        case 'MM': // Modified in both
            return '#E2C08D'; // Yellow/Orange
        case 'A':  // Added (staged)
        case 'AM': // Added and modified
            return '#73C991'; // Green
        case '??': // Untracked
        case 'U':  // Unmerged
            return '#73C991'; // Green
        case 'D':  // Deleted
        case 'DD': // Deleted in both
            return '#F48771'; // Red
        case 'R':  // Renamed
            return '#73C991'; // Green
        case 'C':  // Copied
            return '#73C991'; // Green
        case '!':  // Ignored
            return '#848484'; // Gray
        default:
            return '#E2C08D'; // Default yellow for any modification
    }
};

// Get short display label for git status
const getGitStatusLabel = (status: string): string => {
    switch (status) {
        case 'M':
        case 'MM':
            return 'M';
        case 'A':
        case 'AM':
            return 'A';
        case '??':
            return 'U';
        case 'D':
        case 'DD':
            return 'D';
        case 'R':
            return 'R';
        case 'C':
            return 'C';
        case 'U':
            return '!';
        default:
            return status.charAt(0) || 'M';
    }
};

export default function FileTreeNode({
    node,
    depth = 0,
    selectedPaths,
    expandedPaths,
    loadedChildren,
    gitChanges = [],
    draggedPath,
    inlineEdit,
    onNodeClick,
    onToggleExpand,
    onLoadChildren,
    onContextMenu,
    onDragStart,
    onDragEnd,
    onDrop,
    onOsFilesDrop,
    onInlineCreate,
    onInlineRename,
    onInlineCancel,
}: FileTreeNodeProps) {
    const [isDragOver, setIsDragOver] = useState(false);

    // Use parent state to persist expansion across re-renders
    const expanded = expandedPaths.has(node.path);
    const children = loadedChildren[node.path] || node.children || [];
    const childrenLoaded = node.path in loadedChildren;
    const isDirectory = node.type === 'directory';
    const isSelected = selectedPaths.has(node.path);
    const isDragging = draggedPath === node.path;

    useEffect(() => {
        if (!draggedPath) {
            setIsDragOver(false);
        }
    }, [draggedPath]);

    // Find git status for this file - use EXACT path matching only
    const gitChange = gitChanges.find(change => {
        // Only match by exact path to avoid false positives
        return change.path === node.path;
    });

    // ✅ Don't render deleted files - they should disappear from tree
    // Only hide if we have an EXACT path match with deleted status
    if (gitChange && (gitChange.status === 'D' || gitChange.status === 'DD')) {
        return null;
    }

    // Check if directory contains changed files
    const hasChangedChildren = isDirectory && gitChanges.some(change =>
        change.path.startsWith(node.path + '/') ||
        change.path.startsWith(node.name + '/')
    );

    const handleClick = async (e: React.MouseEvent) => {
        // Selection (single / ctrl+multi) and opening files is handled by parent.
        onNodeClick(node, e);

        // ctrl/cmd+click only toggles selection - don't expand or open.
        if (e.ctrlKey || e.metaKey) return;

        if (isDirectory) {
            if (!expanded && !childrenLoaded) {
                await onLoadChildren(node.path);
            }
            onToggleExpand(node.path);
        }
    };


    // Drag and drop handlers
    const handleDragStart = (e: React.DragEvent) => {
        e.dataTransfer.setData('text/plain', node.path);
        e.dataTransfer.setData('application/x-dbt-craft-path', node.path);
        e.dataTransfer.setData('application/x-dbt-craft-kind', node.type);
        e.dataTransfer.effectAllowed = 'copyMove';
        onDragStart(node.path);
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!isDirectory) return;

        // Files dragged in from the local machine -> upload into this folder.
        if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            setIsDragOver(true);
            return;
        }

        // Internal move of another node into this folder.
        if (draggedPath && draggedPath !== node.path && !node.path.startsWith(draggedPath + '/')) {
            e.preventDefault();
            e.stopPropagation(); // Prevent event bubbling
            e.dataTransfer.dropEffect = 'move';
            setIsDragOver(true);
        }
    };

    const handleDragLeave = () => {
        setIsDragOver(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        if (!isDirectory) return;

        // Internal move takes precedence (identified by our custom MIME type).
        const sourcePath =
            e.dataTransfer.getData('application/x-dbt-craft-path') ||
            e.dataTransfer.getData('text/plain');
        if (sourcePath) {
            onDrop(node.path, sourcePath);
            return;
        }

        // Otherwise it's an upload from the local machine.
        if (e.dataTransfer.files?.length || e.dataTransfer.items?.length) {
            onOsFilesDrop(node.path, e.dataTransfer);
        }
    };

    const handleDragEnd = () => {
        setIsDragOver(false);
        onDragEnd();
    };

    // Check if this node is being renamed
    const isRenaming = inlineEdit && inlineEdit.type === 'rename' && inlineEdit.oldPath === node.path;

    return (
        <div>
            {/* Show inline input instead of node when renaming */}
            {isRenaming && onInlineRename && onInlineCancel ? (
                <InlineInput
                    type={inlineEdit.itemType}
                    initialValue={inlineEdit.oldName}
                    depth={depth}
                    onConfirm={(newName) => onInlineRename(node.path, newName)}
                    onCancel={onInlineCancel}
                />
            ) : (
                <div
                    draggable
                    onClick={handleClick}
                    onContextMenu={(e: React.MouseEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onContextMenu(e, node.path, isDirectory ? 'directory' : 'file');
                    }}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    className={`flex h-7 min-w-max items-center gap-1.5 rounded-sm px-2 text-left text-sm cursor-pointer hover:bg-[#F3F2F1] whitespace-nowrap
                        ${isSelected ? 'bg-[#E8F3FC] text-[#005A9E] ring-1 ring-inset ring-[#C7E0F4]' : ''}
                        ${isDragging ? 'opacity-50' : ''}
                        ${isDragOver ? 'bg-[#0078D4]/10 outline outline-1 outline-dashed outline-[#0078D4]' : ''}
                    `}
                    style={{ paddingLeft: `${depth * 16 + 8}px` }}
                    title={node.path}
                >
                    {isDirectory ? (
                        expanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-[#616161] flex-shrink-0" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-[#616161] flex-shrink-0" />
                        )
                    ) : (
                        <span className="w-3.5 flex-shrink-0" />
                    )}
                    <FileTypeIcon node={node} expanded={expanded} />
                    <span
                        className="min-w-0 flex-1 truncate text-[#242424]"
                        style={gitChange ? { color: getGitStatusColor(gitChange.status) } : undefined}
                    >
                        {node.name}
                    </span>

                    {/* Git status indicator */}
                    {gitChange && (
                        <span
                            className="text-xs font-medium ml-auto px-1 flex-shrink-0"
                            style={{ color: getGitStatusColor(gitChange.status) }}
                            title={`Git status: ${gitChange.status}`}
                        >
                            {getGitStatusLabel(gitChange.status)}
                        </span>
                    )}

                    {/* Directory has changed children indicator */}
                    {isDirectory && hasChangedChildren && !gitChange && (
                        <span
                            className="w-2 h-2 rounded-full ml-auto flex-shrink-0"
                            style={{ backgroundColor: '#E2C08D' }}
                            title="Contains modified files"
                        />
                    )}
                </div>
            )}
            {isDirectory && expanded && (
                <>
                    {/* Inline input for creating inside this folder */}
                    {inlineEdit && inlineEdit.type === 'create' && inlineEdit.parentPath === node.path && onInlineCreate && onInlineCancel && (
                        <InlineInput
                            type={inlineEdit.itemType}
                            depth={depth + 1}
                            onConfirm={(name) => onInlineCreate(node.path, name, inlineEdit.itemType)}
                            onCancel={onInlineCancel}
                        />
                    )}
                    {children.map((child) => (
                        <FileTreeNode
                            key={child.path}
                            node={child}
                            depth={depth + 1}
                            selectedPaths={selectedPaths}
                            expandedPaths={expandedPaths}
                            loadedChildren={loadedChildren}
                            gitChanges={gitChanges}
                            draggedPath={draggedPath}
                            inlineEdit={inlineEdit}
                            onNodeClick={onNodeClick}
                            onToggleExpand={onToggleExpand}
                            onLoadChildren={onLoadChildren}
                            onContextMenu={onContextMenu}
                            onDragStart={onDragStart}
                            onDragEnd={onDragEnd}
                            onDrop={onDrop}
                            onOsFilesDrop={onOsFilesDrop}
                            onInlineCreate={onInlineCreate}
                            onInlineRename={onInlineRename}
                            onInlineCancel={onInlineCancel}
                        />
                    ))}
                </>
            )}
        </div>
    );
}
