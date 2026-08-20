"use client"

import React from "react"
import Link from "next/link"
import { Clock, Database, GitBranch, Trash2 } from "lucide-react"
import { Card, CardContent } from "@/components-v2/ui/card"

interface ProjectCardProps {
  id: string
  name: string
  description: string | null
  git_branch: string
  created_at: string
  onDelete?: (project: { id: string; name: string }) => void
}

export default function ProjectCard({ id, name, description, git_branch, created_at, onDelete }: ProjectCardProps) {
  return (
    <Card className="h-full transition-shadow hover:shadow-md">
      <CardContent className="p-0">
        <div className="group flex h-full flex-col">
          <Link href={`/develop/${id}`} className="flex-1 p-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded bg-[#038387]/10 flex items-center justify-center border-l-4 border-[#038387] shrink-0">
                <Database className="h-5 w-5 text-[#038387]" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900 truncate transition-colors group-hover:text-[#0078D4]">
                  {name}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                  {description || "No description"}
                </p>
                <div className="flex items-center gap-3 mt-3 text-xs text-gray-400">
                  <span className="flex items-center gap-1">
                    <GitBranch className="h-3 w-3" />
                    {git_branch}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          </Link>
          {onDelete && (
            <div className="border-t border-gray-100 px-4 py-2">
              <button
                type="button"
                onClick={() => onDelete({ id, name })}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
