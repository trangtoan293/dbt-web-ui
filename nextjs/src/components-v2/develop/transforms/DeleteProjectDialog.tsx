'use client';

import React, { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
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

interface DeleteProjectDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    projectName: string;
    onSoftDelete?: () => void | Promise<void>;
    onHardDelete?: () => void | Promise<void>;
    onConfirm?: () => void | Promise<void>; // Legacy support
    loading?: boolean;
}

export function DeleteProjectDialog({
    open,
    onOpenChange,
    projectName,
    onSoftDelete,
    onHardDelete,
    onConfirm,
    loading = false,
}: DeleteProjectDialogProps) {
    const [isHardDelete, setIsHardDelete] = useState(false);

    const handleConfirm = async () => {
        if (isHardDelete && onHardDelete) {
            await onHardDelete();
        } else if (onSoftDelete) {
            await onSoftDelete();
        } else if (onConfirm) {
            // Legacy support - direct delete
            await onConfirm();
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            setIsHardDelete(false); // Reset checkbox when closing
        }
        onOpenChange(open);
    };

    return (
        <AlertDialog open={open} onOpenChange={handleOpenChange}>
            <AlertDialogContent className="bg-white border-[#E6E6E6]">
                <AlertDialogHeader>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                            <AlertTriangle className="h-6 w-6 text-red-600" />
                        </div>
                        <AlertDialogTitle className="text-xl text-[#242424]">
                            {isHardDelete ? 'Permanently Delete Project' : 'Delete Project'}
                        </AlertDialogTitle>
                    </div>
                    <AlertDialogDescription className="text-[#616161] text-base">
                        Are you sure you want to {isHardDelete ? 'permanently delete' : 'delete'}{' '}
                        <span className="font-semibold text-[#242424]">&quot;{projectName}&quot;</span>?
                        <br />
                        <br />
                        {isHardDelete ? (
                            <span className="text-red-600 font-medium">
                                ⚠️ This action cannot be undone.
                            </span>
                        ) : (
                            <span className="text-[#616161]">
                                The project will be moved to trash and can be restored later.
                            </span>
                        )}
                        {isHardDelete && (
                            <>
                                {' '}
                                All project files, configurations, and history will be permanently removed.
                            </>
                        )}
                    </AlertDialogDescription>

                    {/* Hard Delete Checkbox */}
                    {(onSoftDelete || onHardDelete) && (
                        <div className="flex items-center gap-2 pt-4 border-t border-[#E6E6E6] mt-4">
                            <input
                                type="checkbox"
                                id="hard-delete-checkbox"
                                checked={isHardDelete}
                                onChange={(e) => setIsHardDelete(e.target.checked)}
                                disabled={loading}
                                className="w-4 h-4 text-red-600 border-gray-300 rounded focus:ring-red-500"
                            />
                            <label
                                htmlFor="hard-delete-checkbox"
                                className="text-sm font-medium text-red-600 cursor-pointer select-none"
                            >
                                Permanently delete (cannot be restored)
                            </label>
                        </div>
                    )}
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
                        className={`${isHardDelete
                                ? 'bg-red-700 hover:bg-red-800'
                                : 'bg-red-600 hover:bg-red-700'
                            } text-white`}
                    >
                        {loading ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Deleting...
                            </>
                        ) : (
                            <>{isHardDelete ? 'Delete Permanently' : 'Move to Trash'}</>
                        )}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
