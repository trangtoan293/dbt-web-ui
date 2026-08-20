'use client';

/**
 * HardDeleteProjectDialog - Warning dialog for permanent deletion
 * Used when deleting already soft-deleted projects
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components-v2/ui/alert-dialog';

interface HardDeleteProjectDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectName: string;
    onConfirm: () => void;
    loading?: boolean;
}

export function HardDeleteProjectDialog({
    open,
    onOpenChange,
    projectName,
    onConfirm,
    loading = false,
}: HardDeleteProjectDialogProps) {
    const handleConfirm = async () => {
        await onConfirm();
        onOpenChange(false);
    };

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                            <AlertTriangle className="h-6 w-6 text-red-600" />
                        </div>
                        <AlertDialogTitle className="text-xl">
                            Permanently Delete Project?
                        </AlertDialogTitle>
                    </div>
                    <AlertDialogDescription className="pt-4 space-y-3">
                        <p>
                            Are you sure you want to permanently delete{' '}
                            <span className="font-semibold text-gray-900">&ldquo;{projectName}&rdquo;</span>?
                        </p>
                        <p className="text-red-600 font-medium">
                            ⚠️ This action cannot be undone. All project data will be lost forever.
                        </p>
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleConfirm}
                        disabled={loading}
                        className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                    >
                        {loading ? 'Deleting...' : 'Delete Permanently'}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
