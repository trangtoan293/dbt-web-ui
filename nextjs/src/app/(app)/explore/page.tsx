"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { AlertCircle, ExternalLink, FileText, Loader2, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import { Card, CardContent } from "@/components-v2/ui/card"
import { Input } from "@/components-v2/ui/input"
import EmptyState from "@/components-v2/shared/EmptyState"
import { dbtApi } from "@/lib/api"
import { cn } from "@/lib/utils"

type Project = {
  id: string
  name: string
  description: string | null
  git_branch?: string | null
  sync_status?: string | null
  updated_at?: string | null
  created_at?: string | null
}

type DocsStatus = "idle" | "checking" | "ready" | "missing" | "error" | "generating"

export default function ExplorePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [docsStatus, setDocsStatus] = useState<DocsStatus>("idle")
  const [docsError, setDocsError] = useState<string | null>(null)
  const [docsUrl, setDocsUrl] = useState<string | null>(null)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )

  const filteredProjects = useMemo(() => {
    const value = query.trim().toLowerCase()
    if (!value) return projects
    return projects.filter((project) =>
      [project.name, project.description, project.git_branch]
        .filter(Boolean)
        .some((field) => field?.toLowerCase().includes(value))
    )
  }, [projects, query])

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectsError(null)
    try {
      const response = await fetch("/api/projects", { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || "Failed to load projects")
      }
      setProjects(data)
      setSelectedProjectId((current) => current ?? data[0]?.id ?? null)
    } catch (error) {
      setProjectsError((error as Error).message)
    } finally {
      setProjectsLoading(false)
    }
  }, [])

  const checkDocs = useCallback(async (projectId: string) => {
    setDocsStatus("checking")
    setDocsError(null)
    setDocsUrl(null)
    try {
      const url = `/api/dbt-docs/view/${projectId}`
      const response = await fetch(url, { cache: "no-store" })
      if (response.ok) {
        setDocsUrl(url)
        setDocsStatus("ready")
        return
      }
      if (response.status === 404) {
        setDocsStatus("missing")
        return
      }
      const message = await response.text()
      throw new Error(message || "Failed to load dbt docs")
    } catch (error) {
      setDocsStatus("error")
      setDocsError((error as Error).message)
    }
  }, [])

  const generateDocs = async () => {
    if (!selectedProject) return
    setDocsStatus("generating")
    setDocsError(null)
    try {
      const result = await dbtApi.generateDocs(selectedProject.id)
      if (!result.success) {
        throw new Error(result.message || "dbt docs generate failed")
      }
      await checkDocs(selectedProject.id)
    } catch (error) {
      setDocsStatus("error")
      setDocsError((error as Error).message)
    }
  }

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (selectedProjectId) {
      checkDocs(selectedProjectId)
    } else {
      setDocsStatus("idle")
      setDocsUrl(null)
    }
  }, [checkDocs, selectedProjectId])

  const busy = docsStatus === "checking" || docsStatus === "generating"

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Explore</h1>
          <p className="mt-1 text-sm text-gray-500">Browse documentation and model lineage</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => selectedProject && checkDocs(selectedProject.id)} disabled={!selectedProject || busy}>
            <RefreshCw className={cn(busy && "animate-spin")} />
            Refresh
          </Button>
          <Button onClick={generateDocs} disabled={!selectedProject || busy}>
            {docsStatus === "generating" ? <Loader2 className="animate-spin" /> : <FileText />}
            Generate Docs
          </Button>
          {docsUrl && (
            <Button variant="outline" asChild>
              <a href={docsUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open
              </a>
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <Card className="min-h-0 overflow-hidden">
          <CardContent className="flex h-full min-h-0 flex-col gap-3 p-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects"
                className="pl-8"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {projectsLoading && (
                <div className="space-y-2">
                  {[1, 2, 3].map((item) => (
                    <div key={item} className="h-20 animate-pulse rounded-md border border-gray-200 bg-gray-50" />
                  ))}
                </div>
              )}

              {!projectsLoading && projectsError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{projectsError}</div>
              )}

              {!projectsLoading && !projectsError && filteredProjects.length === 0 && (
                <div className="rounded-md border border-gray-200 p-4 text-sm text-gray-500">No projects found.</div>
              )}

              {!projectsLoading && !projectsError && filteredProjects.length > 0 && (
                <div className="space-y-2">
                  {filteredProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => setSelectedProjectId(project.id)}
                      className={cn(
                        "w-full rounded-md border p-3 text-left transition-colors",
                        selectedProjectId === project.id
                          ? "border-[#0078D4] bg-blue-50"
                          : "border-gray-200 bg-white hover:bg-gray-50"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">{project.name}</p>
                          <p className="mt-1 line-clamp-2 text-xs text-gray-500">
                            {project.description || project.git_branch || "dbt project"}
                          </p>
                        </div>
                        {project.sync_status && (
                          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                            {project.sync_status}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-[34rem] overflow-hidden">
          <CardContent className="flex h-full min-h-0 flex-col p-0">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">{selectedProject?.name || "Data Explorer"}</p>
                <p className="text-xs text-gray-500">
                  {docsStatus === "ready" && "dbt documentation is available"}
                  {docsStatus === "missing" && "No generated docs found"}
                  {docsStatus === "checking" && "Checking documentation"}
                  {docsStatus === "generating" && "Generating documentation"}
                  {docsStatus === "error" && "Documentation failed to load"}
                  {docsStatus === "idle" && "Select a project"}
                </p>
              </div>
              {selectedProject && (
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/develop/${selectedProject.id}`}>Develop</Link>
                </Button>
              )}
            </div>

            <div className="min-h-0 flex-1 bg-white">
              {docsUrl && docsStatus === "ready" ? (
                <iframe
                  key={docsUrl}
                  src={docsUrl}
                  title={`${selectedProject?.name || "dbt"} docs`}
                  className="h-full min-h-[34rem] w-full border-0"
                />
              ) : (
                <div className="flex h-full min-h-[34rem] items-center justify-center p-6">
                  {busy ? (
                    <div className="flex items-center gap-3 text-sm text-gray-600">
                      <Loader2 className="h-5 w-5 animate-spin text-[#0078D4]" />
                      {docsStatus === "generating" ? "Running dbt docs generate..." : "Loading docs status..."}
                    </div>
                  ) : docsStatus === "missing" ? (
                    <EmptyState
                      icon={FileText}
                      title="Docs not generated"
                      description="Run dbt docs generate to create manifest.json, catalog.json, and the docs site for this project."
                      action={<Button onClick={generateDocs}>Generate Docs</Button>}
                    />
                  ) : docsStatus === "error" ? (
                    <EmptyState
                      icon={AlertCircle}
                      title="Unable to load docs"
                      description={docsError || "Check dbt-runner and project documentation output."}
                      action={<Button variant="outline" onClick={() => selectedProject && checkDocs(selectedProject.id)}>Retry</Button>}
                    />
                  ) : (
                    <EmptyState
                      icon={FileText}
                      title="Data Explorer"
                      description="Select a dbt project to view generated documentation and lineage."
                    />
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
