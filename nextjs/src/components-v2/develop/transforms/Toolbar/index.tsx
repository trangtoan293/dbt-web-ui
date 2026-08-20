'use client';

/**
 * Toolbar - Top action bar with project info
 * Enhanced with rename and delete actions
 */

import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Database, Edit, Trash2, RotateCcw } from 'lucide-react';
import { type DbtProject } from '@/lib/hooks';
import { Button } from '@/components-v2/ui/button';
import ConnectionCheckDialog from '@/components-v2/develop/ConnectionCheckDialog';

interface ToolbarProps {
    project: DbtProject;
    onRunDbt: (command: string) => void;
    onRename?: () => void;
    onDelete?: () => void;
    onRestore?: () => void;
    isDeleted?: boolean;
}

export default function Toolbar({
    project,
    onRename,
    onDelete,
    onRestore,
    isDeleted = false,
}: ToolbarProps) {
    return (
        <div className="bg-white border-b border-[#E6E6E6] px-4 py-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Link
                        href="/develop"
                        className="p-1.5 hover:bg-[#F3F2F1] rounded transition-colors"
                    >
                        <ArrowLeft className="h-4 w-4 text-[#616161]" />
                    </Link>
                    <div className="w-10 h-10 rounded bg-[#038387]/10 flex items-center justify-center border-l-4 border-[#038387]">
                        <Database className="h-5 w-5 text-[#038387]" />
                    </div>
                    <div className="flex items-center gap-2">
                        <h1 className="text-lg font-semibold text-[#242424]">{project.name}</h1>
                        {onRename && !isDeleted && (
                            <button
                                onClick={onRename}
                                className="p-1.5 opacity-60 hover:opacity-100 hover:bg-[#F3F2F1] rounded transition-all"
                                title="Rename project"
                            >
                                <Edit className="h-4 w-4 text-[#616161]" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2">
                    <ConnectionCheckDialog projectId={project.id} />

                    {/* Restore Button (only for deleted projects) */}
                    {isDeleted && onRestore && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onRestore}
                            className="border-green-600 text-green-600 hover:bg-green-50"
                        >
                            <RotateCcw className="h-4 w-4 mr-2" />
                            Restore
                        </Button>
                    )}

                    {/* Delete Button */}
                    {onDelete && (
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={onDelete}
                            className="bg-red-600 hover:bg-red-700 text-white"
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {isDeleted ? 'Delete Permanently' : 'Delete'}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
