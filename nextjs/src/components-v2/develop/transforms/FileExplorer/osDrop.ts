/**
 * Read files (recursively, preserving folder structure) from a drag-and-drop
 * DataTransfer originating from the user's local machine.
 *
 * `webkitGetAsEntry()` must be called synchronously inside the drop handler
 * (the DataTransferItemList is cleared once the event returns), so callers
 * should invoke `entriesFromDataTransfer` first, then await `collectFiles`.
 */

interface FileSystemEntryLike {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (cb: (file: File) => void, err: (e: unknown) => void) => void;
    createReader?: () => {
        readEntries: (cb: (entries: FileSystemEntryLike[]) => void, err: (e: unknown) => void) => void;
    };
}

export interface DroppedFile {
    /** Path relative to the drop target, using forward slashes. */
    relativePath: string;
    file: File;
}

/** Synchronously pull FileSystem entries out of a drop event. */
export function entriesFromDataTransfer(dataTransfer: DataTransfer): FileSystemEntryLike[] {
    const entries: FileSystemEntryLike[] = [];
    const items = dataTransfer.items;
    if (!items) return entries;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'file') continue;
        const entry = (item as DataTransferItem & {
            webkitGetAsEntry?: () => FileSystemEntryLike | null;
        }).webkitGetAsEntry?.();
        if (entry) entries.push(entry);
    }
    return entries;
}

function readFile(entry: FileSystemEntryLike): Promise<File> {
    return new Promise((resolve, reject) => {
        entry.file?.(resolve, reject);
    });
}

function readDirectory(reader: ReturnType<NonNullable<FileSystemEntryLike['createReader']>>): Promise<FileSystemEntryLike[]> {
    return new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
    });
}

async function walkEntry(entry: FileSystemEntryLike, prefix: string): Promise<DroppedFile[]> {
    if (entry.isFile) {
        const file = await readFile(entry);
        return [{ relativePath: prefix ? `${prefix}/${entry.name}` : entry.name, file }];
    }

    if (entry.isDirectory && entry.createReader) {
        const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const reader = entry.createReader();
        const collected: DroppedFile[] = [];

        // readEntries returns at most ~100 entries per call; loop until empty.
        for (;;) {
            const batch = await readDirectory(reader);
            if (batch.length === 0) break;
            for (const child of batch) {
                collected.push(...(await walkEntry(child, dirPath)));
            }
        }
        return collected;
    }

    return [];
}

/** Recursively collect every file from the given top-level entries. */
export async function collectFiles(entries: FileSystemEntryLike[]): Promise<DroppedFile[]> {
    const all: DroppedFile[] = [];
    for (const entry of entries) {
        all.push(...(await walkEntry(entry, '')));
    }
    return all;
}

/** Fallback when entry API is unavailable: flat list from dataTransfer.files. */
export function flatFilesFromDataTransfer(dataTransfer: DataTransfer): DroppedFile[] {
    return Array.from(dataTransfer.files || []).map((file) => ({
        relativePath: file.name,
        file,
    }));
}
