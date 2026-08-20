'use client';

import React from 'react';
import { RotateCcw, Loader2 } from 'lucide-react';
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

interface RestoreProjectDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectName: string;
    onConfirm: () => void | Promise<void>;
    loading?: boolean;
}

export function RestoreProjectDialog({
    open,
    onOpenChange,
    projectName,
    onConfirm,
    loading = false,
}: RestoreProjectDialogProps) {
    const handleConfirm = async () => {
        await onConfirm();
    };

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent className="bg-white border-[#E6E6E6]">
                <AlertDialogHeader>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                            <RotateCcw className="h-6 w-6 text-green-600" />
                        </div>
                        <AlertDialogTitle className="text-xl text-[#242424]">
                            Restore Project
                        </AlertDialogTitle>
                    </div>
                    <AlertDialogDescription className="text-[#616161] text-base">
                        Are you sure you want to restore{' '}
                        <span className="font-semibold text-[#242424]">&quot;{projectName}&quot;</span>?
                        <br />
                        <br />
                        The project will be moved back to your active projects list.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel
                        disabled={loading}
                        className="border-[#E6E6E6] hover:bg-[#F3F2F1]"
                    >
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleConfirm}
                        disabled={loading}
                        className="bg-green-600 hover:bg-green-700 text-white"
                    >
                        {loading ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Restoring...
                            </>
                        ) : (
                            'Restore Project'
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
