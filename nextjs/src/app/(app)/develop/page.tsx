"use client"

import React, { useState, useEffect } from "react"
import Link from "next/link"
import { Plus, Search, FolderGit2 } from "lucide-react"
import { getProjects, hardDeleteProject, softDeleteProject } from "@/lib/api-client"
import { getDbtRunnerUrl } from "@/lib/api/client"
import { Button } from "@/components-v2/ui/button"
import { Input } from "@/components-v2/ui/input"
import ProjectList from "@/components-v2/develop/ProjectList"
import EmptyState from "@/components-v2/shared/EmptyState"
import { DeleteProjectDialog } from "@/components-v2/develop/transforms/DeleteProjectDialog"
import PageHeader from "@/components-v2/layout/PageHeader"

interface DbtProject {
  id: string
  name: string
  description: string | null
  git_branch: string
  sync_status: string
  created_at: string
}

export default function DevelopPage() {
  const [projects, setProjects] = useState<DbtProject[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [search, setSearch] = useState("")
  const [projectToDelete, setProjectToDelete] = useState<{ id: string; name: string } | null>(null)

  const loadProjects = async () => {
    try {
      setLoading(true)
      const data = await getProjects(false)
      setProjects(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error("Failed to load projects", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadProjects()
  }, [])

  const deleteProjectFiles = async (projectId: string, hardDelete: boolean) => {
    const response = await fetch(`${getDbtRunnerUrl()}/project/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, hard_delete: hardDelete }),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.detail || "Failed to delete project files")
    }
  }

  const handleSoftDelete = async () => {
    if (!projectToDelete) return
    try {
      setDeleteLoading(true)
      await deleteProjectFiles(projectToDelete.id, false)
      await softDeleteProject(projectToDelete.id)
      setProjects((current) => current.filter((project) => project.id !== projectToDelete.id))
      setProjectToDelete(null)
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to delete project")
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleHardDelete = async () => {
    if (!projectToDelete) return
    try {
      setDeleteLoading(true)
      await deleteProjectFiles(projectToDelete.id, true)
      await hardDeleteProject(projectToDelete.id)
      setProjects((current) => current.filter((project) => project.id !== projectToDelete.id))
      setProjectToDelete(null)
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to permanently delete project")
    } finally {
      setDeleteLoading(false)
    }
  }

  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.description?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        title="Develop"
        description="Manage your dbt projects and models"
        actions={<Button asChild><Link href="/develop/new"><Plus /> New Project</Link></Button>}
      />

      {projects.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
      )}

      {!loading && projects.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No projects yet"
          description="Create your first dbt project to get started."
          action={
            <Button asChild><Link href="/develop/new"><Plus /> Create Project</Link></Button>
          }
        />
      ) : (
        <ProjectList projects={filtered} loading={loading} onDeleteProject={setProjectToDelete} />
      )}

      <DeleteProjectDialog
        open={!!projectToDelete}
        onOpenChange={(open) => {
          if (!open) setProjectToDelete(null)
        }}
        projectName={projectToDelete?.name || ""}
        onSoftDelete={handleSoftDelete}
        onHardDelete={handleHardDelete}
        loading={deleteLoading}
      />
    </div>
  )
}
