import React from 'react';

interface DbtIconProps {
    className?: string;
}

export default function DbtIcon({ className = 'h-5 w-5' }: DbtIconProps) {
    return (
        <svg
            aria-label="Data transformation"
            role="img"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className={className}
        >
            <ellipse cx="12" cy="5" rx="7.5" ry="3" />
            <path d="M4.5 5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5" />
            <path d="M4.5 11v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
        </svg>
    );
}
