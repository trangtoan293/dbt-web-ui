import { describe, it, expect } from 'vitest';
import {
    parentOf,
    createTargetPath,
    isInsideOrSelf,
    canMoveInto,
    filterRedundantPaths,
    pathsForDrag,
    normalizeRelativePath,
    joinPath,
} from '../src/components-v2/develop/transforms/FileExplorer/explorerUtils';

describe('parentOf', () => {
    it('returns parent folder', () => {
        expect(parentOf('models/staging/stg.sql')).toBe('models/staging');
    });
    it('returns empty string for root-level path', () => {
        expect(parentOf('model.sql')).toBe('');
    });
});

describe('createTargetPath', () => {
    it('targets root when nothing selected', () => {
        expect(createTargetPath(null)).toBe('');
    });
    it('targets the directory itself when a directory is selected', () => {
        expect(createTargetPath({ path: 'models', type: 'directory' })).toBe('models');
    });
    it("targets the file's parent when a file is selected", () => {
        expect(createTargetPath({ path: 'models/a.sql', type: 'file' })).toBe('models');
    });
    it('targets root when a root-level file is selected', () => {
        expect(createTargetPath({ path: 'a.sql', type: 'file' })).toBe('');
    });
});

describe('isInsideOrSelf', () => {
    it('true for self', () => {
        expect(isInsideOrSelf('models', 'models')).toBe(true);
    });
    it('true for descendant', () => {
        expect(isInsideOrSelf('models', 'models/staging')).toBe(true);
    });
    it('false for sibling prefix collision', () => {
        expect(isInsideOrSelf('models', 'models2')).toBe(false);
    });
});

describe('canMoveInto', () => {
    it('rejects moving into itself', () => {
        expect(canMoveInto('models', 'models')).toBe(false);
    });
    it('rejects moving into a descendant', () => {
        expect(canMoveInto('models', 'models/staging')).toBe(false);
    });
    it('rejects no-op move into current parent', () => {
        expect(canMoveInto('models/a.sql', 'models')).toBe(false);
    });
    it('allows a real move', () => {
        expect(canMoveInto('models/a.sql', 'marts')).toBe(true);
    });
});

describe('filterRedundantPaths', () => {
    it('drops descendants when ancestor is also present', () => {
        expect(filterRedundantPaths(['models', 'models/a.sql', 'marts/b.sql'])).toEqual([
            'models',
            'marts/b.sql',
        ]);
    });
    it('dedupes and drops empties', () => {
        expect(filterRedundantPaths(['a', 'a', '', 'b'])).toEqual(['a', 'b']);
    });
    it('keeps siblings with prefix collision', () => {
        expect(filterRedundantPaths(['models', 'models2'])).toEqual(['models', 'models2']);
    });
});

describe('pathsForDrag', () => {
    it('moves whole selection when dragging a selected node', () => {
        const sel = new Set(['a.sql', 'b.sql']);
        expect(pathsForDrag('a.sql', sel).sort()).toEqual(['a.sql', 'b.sql']);
    });
    it('moves only the dragged node when it is not part of selection', () => {
        const sel = new Set(['a.sql', 'b.sql']);
        expect(pathsForDrag('c.sql', sel)).toEqual(['c.sql']);
    });
    it('moves only the dragged node when selection is a single item', () => {
        const sel = new Set(['a.sql']);
        expect(pathsForDrag('a.sql', sel)).toEqual(['a.sql']);
    });
});

describe('normalizeRelativePath', () => {
    it('converts backslashes and strips traversal segments', () => {
        expect(normalizeRelativePath('..\\foo\\.\\bar.sql')).toBe('foo/bar.sql');
    });
    it('returns empty when only traversal segments', () => {
        expect(normalizeRelativePath('../..')).toBe('');
    });
});

describe('joinPath', () => {
    it('joins base and relative', () => {
        expect(joinPath('models', 'staging/a.sql')).toBe('models/staging/a.sql');
    });
    it('uses relative as-is at root', () => {
        expect(joinPath('', 'a.sql')).toBe('a.sql');
    });
    it('returns empty when relative normalizes to nothing', () => {
        expect(joinPath('models', '../')).toBe('');
    });
});
