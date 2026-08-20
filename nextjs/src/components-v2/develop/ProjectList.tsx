"use client"

import React from "react"
import ProjectCard from "./ProjectCard"

interface DbtProject {
  id: string
  name: string
  description: string | null
  git_branch: string
  sync_status: string
  created_at: string
}

interface ProjectListProps {
  projects: DbtProject[]
  loading: boolean
  onDeleteProject?: (project: { id: string; name: string }) => void
}

export default function ProjectList({ projects, loading, onDeleteProject }: ProjectListProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-gray-200 p-4 animate-pulse">
            <div className="flex gap-3">
              <div className="h-10 w-10 rounded bg-gray-200 shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-gray-200 rounded w-3/4" />
                <div className="h-3 bg-gray-100 rounded w-full" />
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (projects.length === 0) {
    return null
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {projects.map((p) => (
        <ProjectCard key={p.id} {...p} onDelete={onDeleteProject} />
      ))}
    </div>
  )
}
