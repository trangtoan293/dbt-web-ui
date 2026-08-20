'use client';

import React from 'react';
import {
    BookOpen,
    Braces,
    Database,
    File,
    FileArchive,
    FileCode,
    FileCog,
    FileJson,
    FileSpreadsheet,
    FileText,
    Folder,
    FolderGit2,
    FolderOpen,
    GitBranch,
    Image,
    Package,
    ScrollText,
    Settings,
    ShieldCheck,
    Table2,
} from 'lucide-react';
import { type FileNode } from '@/lib/hooks';

interface FileIconTheme {
    icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
    color: string;
}

const folderThemes: Record<string, FileIconTheme> = {
    models: { icon: Database, color: '#0078D4' },
    marts: { icon: Database, color: '#0078D4' },
    staging: { icon: Table2, color: '#038387' },
    intermediate: { icon: Table2, color: '#038387' },
    macros: { icon: Braces, color: '#6B69D6' },
    tests: { icon: ShieldCheck, color: '#107C10' },
    seeds: { icon: FileSpreadsheet, color: '#038387' },
    snapshots: { icon: GitBranch, color: '#B7791F' },
    analyses: { icon: FileText, color: '#6B69D6' },
    analysis: { icon: FileText, color: '#6B69D6' },
    docs: { icon: BookOpen, color: '#616161' },
    target: { icon: Package, color: '#A0A0A0' },
    logs: { icon: ScrollText, color: '#A0A0A0' },
    dbt_packages: { icon: Package, color: '#A0A0A0' },
    '.git': { icon: FolderGit2, color: '#616161' },
};

const fileNameThemes: Record<string, FileIconTheme> = {
    'dbt_project.yml': { icon: Settings, color: '#FF694B' },
    'dbt_project.yaml': { icon: Settings, color: '#FF694B' },
    'packages.yml': { icon: Package, color: '#FF694B' },
    'packages.yaml': { icon: Package, color: '#FF694B' },
    'selectors.yml': { icon: ShieldCheck, color: '#6B69D6' },
    'selectors.yaml': { icon: ShieldCheck, color: '#6B69D6' },
    'profiles.yml': { icon: FileCog, color: '#B7791F' },
    'profiles.yaml': { icon: FileCog, color: '#B7791F' },
    'schema.yml': { icon: Database, color: '#0078D4' },
    'schema.yaml': { icon: Database, color: '#0078D4' },
    'sources.yml': { icon: Database, color: '#038387' },
    'sources.yaml': { icon: Database, color: '#038387' },
    'exposures.yml': { icon: FileText, color: '#6B69D6' },
    'exposures.yaml': { icon: FileText, color: '#6B69D6' },
    'README.md': { icon: BookOpen, color: '#616161' },
    '.dbtignore': { icon: FileCog, color: '#616161' },
};

const extensionThemes: Record<string, FileIconTheme> = {
    sql: { icon: Database, color: '#0078D4' },
    yml: { icon: FileCog, color: '#B7791F' },
    yaml: { icon: FileCog, color: '#B7791F' },
    json: { icon: FileJson, color: '#6B69D6' },
    md: { icon: BookOpen, color: '#616161' },
    markdown: { icon: BookOpen, color: '#616161' },
    py: { icon: FileCode, color: '#038387' },
    js: { icon: FileCode, color: '#B7791F' },
    jsx: { icon: FileCode, color: '#B7791F' },
    ts: { icon: FileCode, color: '#0078D4' },
    tsx: { icon: FileCode, color: '#0078D4' },
    csv: { icon: FileSpreadsheet, color: '#038387' },
    tsv: { icon: FileSpreadsheet, color: '#038387' },
    xls: { icon: FileSpreadsheet, color: '#038387' },
    xlsx: { icon: FileSpreadsheet, color: '#038387' },
    png: { icon: Image, color: '#6B69D6' },
    jpg: { icon: Image, color: '#6B69D6' },
    jpeg: { icon: Image, color: '#6B69D6' },
    gif: { icon: Image, color: '#6B69D6' },
    webp: { icon: Image, color: '#6B69D6' },
    svg: { icon: Image, color: '#6B69D6' },
    zip: { icon: FileArchive, color: '#616161' },
    gz: { icon: FileArchive, color: '#616161' },
    tar: { icon: FileArchive, color: '#616161' },
    log: { icon: ScrollText, color: '#A0A0A0' },
    logs: { icon: ScrollText, color: '#A0A0A0' },
    txt: { icon: FileText, color: '#616161' },
};

export function getFileIconTheme(node: FileNode, expanded = false): FileIconTheme {
    if (node.type === 'directory') {
        return folderThemes[node.name.toLowerCase()] || {
            icon: expanded ? FolderOpen : Folder,
            color: '#F2C811',
        };
    }

    const lowerName = node.name.toLowerCase();
    const extension = lowerName.includes('.') ? lowerName.split('.').pop() || '' : '';

    return fileNameThemes[lowerName] || extensionThemes[extension] || {
        icon: File,
        color: '#616161',
    };
}

export function FileTypeIcon({ node, expanded = false, className = 'h-4 w-4 flex-shrink-0' }: {
    node: FileNode;
    expanded?: boolean;
    className?: string;
}) {
    const theme = getFileIconTheme(node, expanded);
    const Icon = theme.icon;

    return <Icon className={className} style={{ color: theme.color }} />;
}
