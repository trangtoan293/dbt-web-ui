/**
 * Hooks Layer - Barrel Export
 * 
 * Usage:
 *   import { useProject, useFileTree, useDbtCommands, useEditor } from '@/lib/hooks';
 */

export { useProject, type DbtProject, type UseProjectReturn } from './useProject';
export { useFileTree, type FileNode, type UseFileTreeReturn } from './useFileTree';
export { useDbtCommands, type QueryResults, type UseDbtCommandsReturn } from './useDbtCommands';
export { useEditor, type OpenTab, type UseEditorReturn } from './useEditor';
export { useFileWatcher, type FileWatcherEvent, type UseFileWatcherOptions, type UseFileWatcherReturn } from './useFileWatcher';
export { useDbtIntellisense, type UseDbtIntellisenseReturn } from './useDbtIntellisense';
