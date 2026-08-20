'use client';

/**
 * InlineInput - Inline input for creating/renaming files and folders
 * Features: Auto-focus, Enter to confirm, Escape to cancel, Click outside to cancel
 */

import React, { useState, useRef, useEffect } from 'react';
import { Folder, FileCode } from 'lucide-react';

interface InlineInputProps {
    type: 'file' | 'directory';
    initialValue?: string;
    depth: number;
    onConfirm: (name: string) => void;
    onCancel: () => void;
    placeholder?: string;
}

export default function InlineInput({
    type,
    initialValue = '',
    depth,
    onConfirm,
    onCancel,
    placeholder,
}: InlineInputProps) {
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Auto-focus and select text on mount
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.focus();
            if (initialValue) {
                // Select filename without extension for rename
                const dotIndex = initialValue.lastIndexOf('.');
                if (dotIndex > 0 && type === 'file') {
                    inputRef.current.setSelectionRange(0, dotIndex);
                } else {
                    inputRef.current.select();
                }
            }
        }
    }, [initialValue, type]);

    // Handle click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            // Check if click is outside the container (not just the input)
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                // If has value, confirm; otherwise cancel
                if (value.trim()) {
                    onConfirm(value.trim());
                } else {
                    onCancel();
                }
            }
        };

        // Delay adding listener to avoid immediate trigger from context menu click
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 200);

        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [value, onConfirm, onCancel]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (value.trim()) {
                onConfirm(value.trim());
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
        }
    };

    return (
        <div
            ref={containerRef}
            className="flex h-7 min-w-0 items-center gap-1.5 rounded-sm bg-[#E8F3FC] px-2 text-sm"
            style={{ paddingLeft: `${depth * 18 + 8}px` }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {/* Spacer for chevron alignment */}
            <span className="w-3.5 flex-shrink-0" />
            
            {/* Icon */}
            {type === 'directory' ? (
                <Folder className="h-4 w-4 text-[#F2C811] flex-shrink-0" />
            ) : (
                <FileCode className="h-4 w-4 text-[#038387] flex-shrink-0" />
            )}
            
            {/* Input */}
            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder || (type === 'file' ? 'model.sql' : 'folder_name')}
                className="h-5 min-w-0 flex-1 rounded border border-[#0078D4] bg-white px-1 text-sm outline-none"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
            />
        </div>
    );
}
