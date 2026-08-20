/**
 * Pure helpers for the FileExplorer.
 * Kept side-effect free so they can be unit tested without a DOM.
 */

export type NodeKind = 'file' | 'directory';

export interface ExplorerSelection {
    path: string;
    type: NodeKind;
}

/** Parent folder path of a given path ('' when at root). */
export function parentOf(path: string): string {
    return path.split('/').slice(0, -1).join('/');
}

/**
 * Folder that a new file/folder should be created inside, given the active
 * selection. Selecting a directory targets that directory; selecting a file
 * targets its parent; no selection targets the root ('').
 */
export function createTargetPath(selected: ExplorerSelection | null): string {
    if (!selected) return '';
    if (selected.type === 'directory') return selected.path;
    return parentOf(selected.path);
}

/** True when `dest` is `source` itself or a descendant of `source`. */
export function isInsideOrSelf(source: string, dest: string): boolean {
    return dest === source || dest.startsWith(source + '/');
}

/**
 * A move from `source` into `dest` is valid only when the destination is not
 * the source itself, not a descendant of the source, and not already the
 * direct parent (which would be a no-op).
 */
export function canMoveInto(source: string, dest: string): boolean {
    if (isInsideOrSelf(source, dest)) return false;
    if (parentOf(source) === dest) return false;
    return true;
}

/**
 * Drop any path that is a descendant of another path in the same set. Moving a
 * folder already moves its children, so moving both the folder and a child is
 * redundant (and would 404 on the child after the parent move).
 */
export function filterRedundantPaths(paths: string[]): string[] {
    const unique = Array.from(new Set(paths.filter(Boolean)));
    return unique.filter(
        (p) => !unique.some((other) => other !== p && p.startsWith(other + '/'))
    );
}

/** Given a multi-selection and the dragged node, the set of paths to move. */
export function pathsForDrag(draggedPath: string, selectedPaths: Set<string>): string[] {
    if (selectedPaths.has(draggedPath) && selectedPaths.size > 1) {
        return filterRedundantPaths([...selectedPaths]);
    }
    return [draggedPath];
}

/**
 * Normalize a relative upload path: forward slashes, drop empty / '.' / '..'
 * segments so an uploaded file can never escape the target folder.
 */
export function normalizeRelativePath(path: string): string {
    return path
        .replace(/\\/g, '/')
        .split('/')
        .filter((segment) => segment && segment !== '.' && segment !== '..')
        .join('/');
}

/** Join an explorer base path with a normalized relative path. */
export function joinPath(basePath: string, relativePath: string): string {
    const clean = normalizeRelativePath(relativePath);
    if (!clean) return '';
    return basePath ? `${basePath}/${clean}` : clean;
}
