'use client';

import React, { useState, useEffect } from 'react';
import { Edit, Loader2 } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components-v2/ui/dialog';
import { Button } from '@/components-v2/ui/button';
import { Input } from '@/components-v2/ui/input';

interface RenameProjectDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    currentName: string;
    onConfirm: (newName: string) => void | Promise<void>;
    loading?: boolean;
}

export function RenameProjectDialog({
    open,
    onOpenChange,
    currentName,
    onConfirm,
    loading = false,
}: RenameProjectDialogProps) {
    const [newName, setNewName] = useState(currentName);
    const [error, setError] = useState<string | null>(null);

    // Reset state when dialog opens
    useEffect(() => {
        if (open) {
            setNewName(currentName);
            setError(null);
        }
    }, [open, currentName]);

    const validateName = (name: string): string | null => {
        if (!name.trim()) {
            return 'Project name cannot be empty';
        }
        if (name.length > 100) {
            return 'Project name must be less than 100 characters';
        }
        if (name === currentName) {
            return 'New name must be different from current name';
        }
        return null;
    };

    const handleConfirm = async () => {
        const validationError = validateName(newName);
        if (validationError) {
            setError(validationError);
            return;
        }

        setError(null);
        await onConfirm(newName.trim());
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !loading) {
            e.preventDefault();
            handleConfirm();
        }
    };

    const isValid = !validateName(newName) && !loading;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="bg-white border-[#E6E6E6] sm:max-w-md">
                <DialogHeader>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-full bg-[#0078D4]/10 flex items-center justify-center">
                            <Edit className="h-5 w-5 text-[#0078D4]" />
                        </div>
                        <DialogTitle className="text-lg text-[#242424]">
                            Rename Project
                        </DialogTitle>
                    </div>
                    <DialogDescription className="text-[#616161]">
                        Enter a new name for your project
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="space-y-2">
                        <label
                            htmlFor="project-name"
                            className="text-sm font-medium text-[#242424]"
                        >
                            Project Name
                        </label>
                        <Input
                            id="project-name"
                            value={newName}
                            onChange={(e) => {
                                setNewName(e.target.value);
                                setError(null);
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder="Enter project name"
                            className="border-[#E6E6E6] focus:border-[#0078D4] focus:ring-[#0078D4]"
                            disabled={loading}
                            autoFocus
                        />
                        {error && (
                            <p className="text-sm text-red-600">{error}</p>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={loading}
                        className="border-[#E6E6E6] hover:bg-[#F3F2F1]"
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleConfirm}
                        disabled={!isValid}
                        className="bg-[#0078D4] hover:bg-[#106EBE]"
                    >
                        {loading ? (
                            <>
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            'Save'
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
