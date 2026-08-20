'use client';

/**
 * FileExplorer - File tree sidebar component
 * Features: Git status indicators, Search filtering, Horizontal scroll,
 *           Drag and Drop, Cut/Copy/Paste/Duplicate
 */

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Search, Plus, Folder, Trash2, Pencil, RefreshCw, FolderPlus, X, Upload, FolderUp } from 'lucide-react';
import FileTreeNode from './FileTreeNode';
import InlineInput from './InlineInput';
import { type FileNode } from '@/lib/hooks';
import { filesApi } from '@/lib/api/files';
import { FileTypeIcon } from './fileIconTheme';
import { createTargetPath, canMoveInto, pathsForDrag, joinPath } from './explorerUtils';
import { entriesFromDataTransfer, collectFiles, flatFilesFromDataTransfer } from './osDrop';

interface GitChange {
    status: string;
    path: string;
}


// Inline edit state for create/rename
export interface InlineEditState {
    type: 'create' | 'rename';
    itemType: 'file' | 'directory';
    parentPath: string;  // For create: parent folder path; For rename: parent folder path
    oldName?: string;    // For rename: current name
    oldPath?: string;    // For rename: full path
}

interface FileExplorerProps {
    projectId: string;
    fileTree: FileNode[];
    expandedPaths: Set<string>;
    loadedChildren: Record<string, FileNode[]>;
    selectedFile: string | null;
    searchQuery: string;
    gitChanges?: GitChange[];
    onSearchChange: (query: string) => void;
    onFileSelect: (path: string) => void;
    onToggleExpand: (path: string) => void;
    onLoadChildren: (path: string) => Promise<FileNode[]>;
    onCreateFile: (parentPath: string, name: string, type: 'file' | 'directory') => void;
    onDeleteFile: (path: string) => void;
    onRenameFile: (oldPath: string, newName: string) => void;
    onMoveFile?: (sourcePath: string, destPath: string) => void;
    onMoveFiles?: (sourcePaths: string[], destPath: string) => void;
    onDeleteFiles?: (paths: string[]) => void;
    onFilesUploaded?: (paths: string[]) => void;
    onRefresh?: () => void;
    isRefreshing?: boolean;  // Show refresh animation when syncing
    fileWatcherConnected?: boolean;  // file-watch SSE connection status
    createFileTrigger?: number;
}

interface ContextMenuState {
    x: number;
    y: number;
    path: string;
    type: 'file' | 'directory';
}

// Flatten tree to list for searching
function flattenTree(nodes: FileNode[], loadedChildren: Record<string, FileNode[]>): FileNode[] {
    const result: FileNode[] = [];

    function traverse(node: FileNode) {
        result.push(node);
        // Include both static children and loaded children
        const children = loadedChildren[node.path] || node.children || [];
        for (const child of children) {
            traverse(child);
        }
    }

    for (const node of nodes) {
        traverse(node);
    }

    return result;
}

// Filter nodes by search query
function filterNodes(nodes: FileNode[], query: string, loadedChildren: Record<string, FileNode[]>): FileNode[] {
    if (!query.trim()) return [];

    const lowerQuery = query.toLowerCase();
    const flatList = flattenTree(nodes, loadedChildren);

    return flatList.filter(node =>
        node.name.toLowerCase().includes(lowerQuery) ||
        node.path.toLowerCase().includes(lowerQuery)
    );
}

export default function FileExplorer({
    projectId,
    fileTree,
    expandedPaths,
    loadedChildren,
    selectedFile,
    searchQuery,
    gitChanges = [],
    onSearchChange,
    onFileSelect,
    onToggleExpand,
    onLoadChildren,
    onCreateFile,
    onDeleteFile,
    onRenameFile,
    onMoveFile,
    onMoveFiles,
    onDeleteFiles,
    onFilesUploaded,
    onRefresh,
    isRefreshing = false,
    fileWatcherConnected = false,
    createFileTrigger = 0,
}: FileExplorerProps) {
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [draggedPath, setDraggedPath] = useState<string | null>(null);
    // Multi-selection (ctrl/cmd+click). `anchorPath` is the last-clicked node,
    // used as the target folder for create actions.
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [anchorPath, setAnchorPath] = useState<string | null>(null);
    const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
    const [remoteSearchResults, setRemoteSearchResults] = useState<FileNode[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [isRootDragOver, setIsRootDragOver] = useState(false);
    const [uploading, setUploading] = useState(false);
    const fileUploadInputRef = useRef<HTMLInputElement>(null);
    const folderUploadInputRef = useRef<HTMLInputElement>(null);

    const resetDragState = useCallback(() => {
        setDraggedPath(null);
        setIsRootDragOver(false);
    }, []);

    const findNodeByPath = useCallback((path: string): FileNode | null => {
        const visit = (nodes: FileNode[]): FileNode | null => {
            for (const node of nodes) {
                if (node.path === path) return node;
                const children = loadedChildren[node.path] || node.children || [];
                const found = visit(children);
                if (found) return found;
            }
            return null;
        };

        return visit(fileTree);
    }, [fileTree, loadedChildren]);

    useEffect(() => {
        if (createFileTrigger > 0) {
            setInlineEdit({ type: 'create', itemType: 'file', parentPath: '' });
        }
    }, [createFileTrigger]);

    // Close context menu when clicking outside
    useEffect(() => {
        const handleClickOutside = () => setContextMenu(null);
        if (contextMenu) {
            document.addEventListener('click', handleClickOutside);
        }
        return () => document.removeEventListener('click', handleClickOutside);
    }, [contextMenu]);

    // Keyboard shortcuts: F2 for rename, Delete for delete
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if inline editing is active
            if (inlineEdit) return;

            // The single node F2/Delete act on: prefer the last-clicked node.
            const activePath = anchorPath || selectedFile;
            if (!activePath && selectedPaths.size === 0) return;

            // Ignore if user is typing in an input/textarea
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

            // F2 - Rename the active file/folder (single only)
            if (e.key === 'F2' && activePath) {
                e.preventDefault();

                const selectedNode = findNodeByPath(activePath);
                if (selectedNode) {
                    const oldPath = activePath;
                    const parentPath = oldPath.split('/').slice(0, -1).join('/');
                    const oldName = oldPath.split('/').pop() || '';

                    setInlineEdit({
                        type: 'rename',
                        itemType: selectedNode.type === 'directory' ? 'directory' : 'file',
                        parentPath,
                        oldName,
                        oldPath,
                    });
                }
            }

            // Delete - Delete the whole selection (handlers confirm)
            if (e.key === 'Delete') {
                e.preventDefault();
                const paths = selectedPaths.size > 0
                    ? [...selectedPaths]
                    : activePath
                        ? [activePath]
                        : [];
                if (paths.length === 0) return;
                if (paths.length === 1) onDeleteFile(paths[0]);
                else if (onDeleteFiles) onDeleteFiles(paths);
                else paths.forEach(onDeleteFile);
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [selectedFile, anchorPath, selectedPaths, inlineEdit, findNodeByPath, onDeleteFile, onDeleteFiles]);

    const handleContextMenu = (e: React.MouseEvent, path: string, type: 'file' | 'directory') => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, path, type });
    };

    // Drag and drop handlers
    const handleDragStart = useCallback((path: string) => {
        setDraggedPath(path);
        // Dragging a node that isn't part of the current selection collapses
        // the selection to just that node (VS Code behaviour).
        setSelectedPaths((prev) => (prev.has(path) ? prev : new Set([path])));
        setAnchorPath(path);
    }, []);

    const handleDragEnd = useCallback(() => {
        resetDragState();
    }, [resetDragState]);

    const handleDrop = useCallback((destPath: string, sourcePath?: string) => {
        // Use sourcePath from dataTransfer if provided, fallback to state
        const primary = sourcePath || draggedPath;
        if (!primary) {
            resetDragState();
            return;
        }
        // Move the whole selection when the dragged node is part of it.
        const sources = pathsForDrag(primary, selectedPaths).filter((src) =>
            canMoveInto(src, destPath)
        );
        if (sources.length === 1) {
            onMoveFile?.(sources[0], destPath);
        } else if (sources.length > 1) {
            if (onMoveFiles) onMoveFiles(sources, destPath);
            else sources.forEach((src) => onMoveFile?.(src, destPath));
        }
        resetDragState();
    }, [draggedPath, selectedPaths, onMoveFile, onMoveFiles, resetDragState]);

    useEffect(() => {
        document.addEventListener('dragend', resetDragState);
        document.addEventListener('drop', resetDragState);
        return () => {
            document.removeEventListener('dragend', resetDragState);
            document.removeEventListener('drop', resetDragState);
        };
    }, [resetDragState]);

    // Count changed files
    const changedFilesCount = gitChanges.length;

    const isSearching = searchQuery.trim().length > 0;

    const localSearchResults = useMemo(() =>
        filterNodes(fileTree, searchQuery, loadedChildren),
        [fileTree, searchQuery, loadedChildren]
    );

    const searchResults = isSearching ? remoteSearchResults : localSearchResults;

    // Keep multi-selection in sync with the externally-driven selected file
    // (tab switches, opening from search, creating a file).
    useEffect(() => {
        if (selectedFile) {
            setSelectedPaths(new Set([selectedFile]));
            setAnchorPath(selectedFile);
        }
    }, [selectedFile]);

    // The folder that create / upload actions target, based on the last click.
    const activeSelection = useMemo(() => {
        if (!anchorPath) return null;
        const node = findNodeByPath(anchorPath);
        return node ? { path: anchorPath, type: node.type } : null;
    }, [anchorPath, findNodeByPath]);

    const getUploadBasePath = useCallback(
        () => createTargetPath(activeSelection),
        [activeSelection]
    );

    // Click handling: ctrl/cmd toggles a node in the multi-selection; a plain
    // click on a file opens it, a plain click on a folder just selects it.
    const handleNodeClick = useCallback(
        (node: FileNode, e: React.MouseEvent) => {
            const multi = e.ctrlKey || e.metaKey;
            if (multi) {
                setSelectedPaths((prev) => {
                    const next = new Set(prev);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                });
                setAnchorPath(node.path);
                return;
            }
            setSelectedPaths(new Set([node.path]));
            setAnchorPath(node.path);
            if (node.type === 'file') onFileSelect(node.path);
        },
        [onFileSelect]
    );

    // Start an inline create inside the active folder, expanding it if needed.
    const startCreate = useCallback(
        (itemType: 'file' | 'directory') => {
            const parentPath = createTargetPath(activeSelection);
            setInlineEdit({ type: 'create', itemType, parentPath });
            if (parentPath && !expandedPaths.has(parentPath)) {
                onToggleExpand(parentPath);
            }
        },
        [activeSelection, expandedPaths, onToggleExpand]
    );

    // Upload files/folders dragged in from the user's local machine.
    const handleOsFilesDrop = useCallback(
        async (destPath: string, dataTransfer: DataTransfer) => {
            // Pull entries synchronously before any await (the item list is
            // cleared once the drop event returns).
            const entries = entriesFromDataTransfer(dataTransfer);
            setUploading(true);
            try {
                const dropped = entries.length
                    ? await collectFiles(entries)
                    : flatFilesFromDataTransfer(dataTransfer);

                const uploadedPaths: string[] = [];
                for (const { relativePath, file } of dropped) {
                    const targetPath = joinPath(destPath, relativePath);
                    if (!targetPath) continue;
                    await filesApi.save(projectId, targetPath, await file.text());
                    uploadedPaths.push(targetPath);
                }
                if (uploadedPaths.length > 0) onFilesUploaded?.(uploadedPaths);
            } catch (error) {
                alert(error instanceof Error ? error.message : 'Failed to upload files');
            } finally {
                setUploading(false);
            }
        },
        [projectId, onFilesUploaded]
    );

    const normalizeUploadPath = (path: string) =>
        path
            .replace(/\\/g, '/')
            .split('/')
            .filter((segment) => segment && segment !== '.' && segment !== '..')
            .join('/');

    const handleUploadSelection = async (fileList: FileList | null, preserveRelativePath: boolean) => {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;

        const basePath = getUploadBasePath();
        const uploadedPaths: string[] = [];
        setUploading(true);

        try {
            for (const file of files) {
                const fileWithRelativePath = file as File & { webkitRelativePath?: string };
                const relativePath = preserveRelativePath
                    ? fileWithRelativePath.webkitRelativePath || file.name
                    : file.name;
                const cleanRelativePath = normalizeUploadPath(relativePath);
                if (!cleanRelativePath) continue;

                const targetPath = basePath ? `${basePath}/${cleanRelativePath}` : cleanRelativePath;
                await filesApi.save(projectId, targetPath, await file.text());
                uploadedPaths.push(targetPath);
            }

            if (uploadedPaths.length > 0) {
                onFilesUploaded?.(uploadedPaths);
            }
        } catch (error) {
            alert(error instanceof Error ? error.message : 'Failed to upload files');
        } finally {
            setUploading(false);
            if (fileUploadInputRef.current) fileUploadInputRef.current.value = '';
            if (folderUploadInputRef.current) folderUploadInputRef.current.value = '';
        }
    };

    useEffect(() => {
        const query = searchQuery.trim();

        if (!query) {
            setRemoteSearchResults([]);
            setSearchError(null);
            setSearchLoading(false);
            return;
        }

        let cancelled = false;
        const timer = window.setTimeout(async () => {
            setSearchLoading(true);
            setSearchError(null);

            try {
                const response = await filesApi.search(projectId, query);
                if (cancelled) return;

                setRemoteSearchResults(response.results.map((node) => ({
                    ...node,
                    type: node.type === 'folder' ? 'directory' : 'file',
                })));
            } catch (error) {
                if (cancelled) return;

                setRemoteSearchResults([]);
                setSearchError(error instanceof Error ? error.message : 'Search failed');
            } finally {
                if (!cancelled) {
                    setSearchLoading(false);
                }
            }
        }, 250);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [projectId, searchQuery]);

    // Get git status for a file
    const getGitStatus = (path: string) => {
        return gitChanges.find(change =>
            change.path === path ||
            path.endsWith('/' + change.path) ||
            change.path.endsWith('/' + path.split('/').pop())
        );
    };

    // Handle drop on root folder (empty space)
    const handleRootDrop = (e: React.DragEvent) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        setIsRootDragOver(false);
        const sourcePath =
            e.dataTransfer.getData('application/x-dbt-craft-path') ||
            e.dataTransfer.getData('text/plain');
        if (sourcePath) {
            handleDrop('', sourcePath);
            return;
        }
        // Files dragged in from the local machine -> upload to root.
        if (e.dataTransfer.files?.length || e.dataTransfer.items?.length) {
            handleOsFilesDrop('', e.dataTransfer);
        }
    };

    const handleRootDragOver = (e: React.DragEvent) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move';
        setIsRootDragOver(true);
    };

    const handleRootDragLeave = (e: React.DragEvent) => {
        if (e.target !== e.currentTarget) return;
        setIsRootDragOver(false);
    };

    const handleSearchResultDragStart = (e: React.DragEvent, path: string) => {
        const node = findNodeByPath(path);
        e.dataTransfer.setData('text/plain', path);
        e.dataTransfer.setData('application/x-dbt-craft-path', path);
        e.dataTransfer.setData('application/x-dbt-craft-kind', node?.type || 'file');
        e.dataTransfer.effectAllowed = 'copyMove';
        handleDragStart(path);
    };

    const handleSearchResultDragOver = (e: React.DragEvent, node: FileNode) => {
        if (node.type !== 'directory') return;
        const sourcePath = draggedPath || e.dataTransfer.getData('text/plain');
        if (!sourcePath || sourcePath === node.path || node.path.startsWith(sourcePath + '/')) return;

        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
    };

    const handleSearchResultDrop = (e: React.DragEvent, node: FileNode) => {
        e.preventDefault();
        e.stopPropagation();
        if (node.type !== 'directory') return;

        const sourcePath = e.dataTransfer.getData('text/plain');
        if (sourcePath) {
            handleDrop(node.path, sourcePath);
        }
    };

    // Handle context menu on empty space (root)
    const handleEmptySpaceContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY, path: '', type: 'directory' });
    };

    return (
        <>
            {/* Header with refresh button */}
            <div className="flex items-center justify-between border-b border-[#E6E6E6] bg-[#FAF9F8] px-2.5 py-2">
                <span className="flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[#616161]">
                    Files
                    {changedFilesCount > 0 && (
                        <span className="rounded-full bg-[#E2C08D]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[#B7791F]">
                            {changedFilesCount}
                        </span>
                    )}
                </span>
                <div className="flex items-center gap-1">
                    <input
                        ref={fileUploadInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(event) => handleUploadSelection(event.target.files, false)}
                    />
                    <input
                        ref={(input) => {
                            folderUploadInputRef.current = input;
                            input?.setAttribute('webkitdirectory', '');
                        }}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(event) => handleUploadSelection(event.target.files, true)}
                    />
                    <button
                        onClick={() => startCreate('file')}
                        className="flex h-7 w-7 items-center justify-center rounded text-[#616161] hover:bg-[#E6E6E6] hover:text-[#242424]"
                        title="New File"
                        aria-label="New File"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={() => startCreate('directory')}
                        className="flex h-7 w-7 items-center justify-center rounded text-[#616161] hover:bg-[#E6E6E6] hover:text-[#242424]"
                        title="New Folder"
                        aria-label="New Folder"
                    >
                        <FolderPlus className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={() => fileUploadInputRef.current?.click()}
                        className="flex h-7 w-7 items-center justify-center rounded text-[#616161] hover:bg-[#E6E6E6] hover:text-[#242424] disabled:opacity-60"
                        title="Upload Files"
                        aria-label="Upload Files"
                        disabled={uploading}
                    >
                        <Upload className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={() => folderUploadInputRef.current?.click()}
                        className="flex h-7 w-7 items-center justify-center rounded text-[#616161] hover:bg-[#E6E6E6] hover:text-[#242424] disabled:opacity-60"
                        title="Upload Folder"
                        aria-label="Upload Folder"
                        disabled={uploading}
                    >
                        <FolderUp className="h-3.5 w-3.5" />
                    </button>
                    {/* file-watch SSE connection status */}
                    <div
                        className="flex h-7 w-5 items-center justify-center"
                        title={fileWatcherConnected ? "Real-time sync active" : "Real-time sync disconnected"}
                    >
                        <div className={`w-2 h-2 rounded-full ${fileWatcherConnected ? 'bg-green-500' : 'bg-gray-400'}`} />
                    </div>
                    {onRefresh && (
                        <button
                            onClick={onRefresh}
                            className="flex h-7 w-7 items-center justify-center rounded text-[#616161] hover:bg-[#E6E6E6] hover:text-[#242424] disabled:opacity-60"
                            title="Sync from storage"
                            disabled={isRefreshing}
                        >
                            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
                        </button>
                    )}
                </div>
            </div>

            {/* Search Bar */}
            <div className="border-b border-[#E6E6E6] p-2">
                <div className="relative">
                    <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-[#616161]" />
                    <input
                        type="text"
                        placeholder="Search"
                        value={searchQuery}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
                        className="h-8 w-full rounded border border-[#E6E6E6] bg-white pl-8 pr-8 text-sm focus:border-[#0078D4] focus:outline-none"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => onSearchChange('')}
                            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[#616161] hover:bg-[#F3F2F1] hover:text-[#242424]"
                            title="Clear search"
                            aria-label="Clear search"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {/* File Tree or Search Results */}
            <div
                className={`flex-1 overflow-auto px-1.5 py-1.5 ${isRootDragOver ? 'bg-[#0078D4]/10 outline outline-2 outline-dashed outline-[#0078D4]' : ''
                    }`}
                onDrop={handleRootDrop}
                onDragOver={handleRootDragOver}
                onDragLeave={handleRootDragLeave}
                onContextMenu={handleEmptySpaceContextMenu}
            >
                {isSearching ? (
                    // Search Results - Flat list
                    <>
                        {searchResults.length > 0 ? (
                            <>
                                <div className="px-2 py-1 text-xs text-[#616161]">
                                    {searchLoading
                                        ? 'Searching...'
                                        : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`}
                                    {searchError && (
                                        <span className="ml-2 text-[#D13438]">
                                            {searchError}
                                        </span>
                                    )}
                                </div>
                                {searchResults.map((node) => {
                                    const gitChange = getGitStatus(node.path);
                                    const isSelected = selectedFile === node.path;
                                    const isDirectory = node.type === 'directory';

                                    return (
                                        <div
                                            key={node.path}
                                            draggable
                                            onClick={() => !isDirectory && onFileSelect(node.path)}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                handleContextMenu(e, node.path, isDirectory ? 'directory' : 'file');
                                            }}
                                            onDragStart={(e) => handleSearchResultDragStart(e, node.path)}
                                            onDragOver={(e) => handleSearchResultDragOver(e, node)}
                                            onDrop={(e) => handleSearchResultDrop(e, node)}
                                            onDragEnd={handleDragEnd}
                                            className={`flex h-8 min-w-0 items-center gap-1.5 rounded-sm px-2 text-sm cursor-pointer hover:bg-[#F3F2F1] ${isSelected ? 'bg-[#E8F3FC]' : ''
                                                } ${draggedPath === node.path ? 'opacity-50' : ''}`}
                                        >
                                            <FileTypeIcon node={node} />
                                            <div className="flex flex-col min-w-0 flex-1">
                                                <span
                                                    className="truncate"
                                                    style={gitChange ? { color: gitChange.status === 'M' || gitChange.status === 'MM' ? '#E2C08D' : gitChange.status === 'D' ? '#F48771' : '#73C991' } : { color: '#242424' }}
                                                >
                                                    {node.name}
                                                </span>
                                                <span className="text-[10px] text-[#A0A0A0] truncate">
                                                    {node.path}
                                                </span>
                                            </div>
                                            {gitChange && (
                                                <span
                                                    className="text-xs font-medium flex-shrink-0"
                                                    style={{ color: gitChange.status === 'M' || gitChange.status === 'MM' ? '#E2C08D' : gitChange.status === 'D' ? '#F48771' : '#73C991' }}
                                                >
                                                    {gitChange.status.charAt(0)}
                                                </span>
                                            )}
                                        </div>
                                    );
                                })}
                            </>
                        ) : (
                            <div className="px-2 py-4 text-center text-sm text-[#616161]">
                                {searchLoading
                                    ? 'Searching...'
                                    : searchError
                                        ? searchError
                                        : <>No files found for &quot;{searchQuery}&quot;</>}
                            </div>
                        )}
                    </>
                ) : (
                    // Normal Tree View
                    <>
                        {/* Inline input for creating at root level */}
                        {inlineEdit && inlineEdit.type === 'create' && inlineEdit.parentPath === '' && (
                            <InlineInput
                                type={inlineEdit.itemType}
                                depth={0}
                                onConfirm={(name) => {
                                    onCreateFile('', name, inlineEdit.itemType);
                                    setInlineEdit(null);
                                }}
                                onCancel={() => setInlineEdit(null)}
                            />
                        )}
                        {fileTree.length === 0 ? (
                            <div className="px-3 py-8 text-center">
                                <Folder className="mx-auto mb-2 h-7 w-7 text-[#A0A0A0]" />
                                <p className="text-sm font-medium text-[#616161]">No files yet</p>
                                <button
                                    type="button"
                                    onClick={() => setInlineEdit({ type: 'create', itemType: 'file', parentPath: '' })}
                                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded border border-[#E6E6E6] px-2.5 text-xs font-medium text-[#242424] hover:bg-[#F3F2F1]"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    New file
                                </button>
                            </div>
                        ) : (
                            fileTree.map((node) => (
                                <FileTreeNode
                                    key={node.path}
                                    node={node}
                                    selectedPaths={selectedPaths}
                                    expandedPaths={expandedPaths}
                                    loadedChildren={loadedChildren}
                                    gitChanges={gitChanges}
                                    draggedPath={draggedPath}
                                    inlineEdit={inlineEdit}
                                    onNodeClick={handleNodeClick}
                                    onToggleExpand={onToggleExpand}
                                    onLoadChildren={onLoadChildren}
                                    onContextMenu={handleContextMenu}
                                    onDragStart={handleDragStart}
                                    onDragEnd={handleDragEnd}
                                    onDrop={handleDrop}
                                    onOsFilesDrop={handleOsFilesDrop}
                                    onInlineCreate={(parentPath, name, type) => {
                                        onCreateFile(parentPath, name, type);
                                        setInlineEdit(null);
                                    }}
                                    onInlineRename={(oldPath, newName) => {
                                        const oldName = oldPath.split('/').pop() || '';
                                        if (newName !== oldName) {
                                            onRenameFile(oldPath, newName);
                                        }
                                        setInlineEdit(null);
                                    }}
                                    onInlineCancel={() => setInlineEdit(null)}
                                />
                            ))
                        )}
                    </>
                )}
            </div>

            {/* Context Menu */}
            {contextMenu && (
                <div
                    className="fixed bg-white border border-[#E6E6E6] rounded shadow-lg z-50 min-w-[160px]"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    <button
                        onClick={() => {
                            const parentPath = contextMenu.type === 'directory' ? contextMenu.path : '';
                            setInlineEdit({ type: 'create', itemType: 'file', parentPath });
                            if (parentPath && !expandedPaths.has(parentPath)) {
                                onToggleExpand(parentPath);
                            }
                            setContextMenu(null);
                        }}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                    >
                        <Plus className="h-4 w-4" /> New File
                    </button>
                    <button
                        onClick={() => {
                            const parentPath = contextMenu.type === 'directory' ? contextMenu.path : '';
                            setInlineEdit({ type: 'create', itemType: 'directory', parentPath });
                            if (parentPath && !expandedPaths.has(parentPath)) {
                                onToggleExpand(parentPath);
                            }
                            setContextMenu(null);
                        }}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                    >
                        <Folder className="h-4 w-4" /> New Folder
                    </button>
                    {contextMenu.path.trim().length > 0 && (
                        <>
                            <div className="border-t border-[#E6E6E6]" />
                            <button
                                onClick={() => {
                                    const oldPath = contextMenu.path.trim();
                                    const parentPath = oldPath.split('/').slice(0, -1).join('/');
                                    const oldName = oldPath.split('/').pop() || '';
                                    setInlineEdit({
                                        type: 'rename',
                                        itemType: contextMenu.type,
                                        parentPath,
                                        oldName,
                                        oldPath,
                                    });
                                    setContextMenu(null);
                                }}
                                className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2"
                            >
                                <Pencil className="h-4 w-4" /> Rename
                            </button>
                            <button
                                onClick={() => {
                                    const targetPath = contextMenu.path.trim();
                                    // Delete the whole selection when right-clicking
                                    // one of several selected nodes.
                                    if (selectedPaths.has(targetPath) && selectedPaths.size > 1) {
                                        const paths = [...selectedPaths];
                                        if (onDeleteFiles) onDeleteFiles(paths);
                                        else paths.forEach(onDeleteFile);
                                    } else {
                                        onDeleteFile(targetPath);
                                    }
                                    setContextMenu(null);
                                }}
                                className="w-full px-3 py-2 text-sm text-left hover:bg-[#F3F2F1] flex items-center gap-2 text-red-600"
                            >
                                <Trash2 className="h-4 w-4" />
                                {selectedPaths.has(contextMenu.path.trim()) && selectedPaths.size > 1
                                    ? `Delete ${selectedPaths.size} items`
                                    : 'Delete'}
                            </button>
                        </>
                    )}
                </div>
            )}
        </>
    );
}
