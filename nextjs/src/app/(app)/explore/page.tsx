"use client"

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, Boxes, ExternalLink, FileText, Loader2, RefreshCw, Terminal, MoreHorizontal } from "lucide-react"
import { Button } from "@/components-v2/ui/button"
import EmptyState from "@/components-v2/shared/EmptyState"
import { dbtApi } from "@/lib/api"
import { cn } from "@/lib/utils"
import DashboardWorkspace, { type BoardAddition } from "@/components-v2/explore/DashboardWorkspace"
import SqlConsole from "@/components-v2/explore/SqlConsole"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components-v2/ui/dropdown-menu"

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
type ExploreView = "docs" | "sql" | "dashboards"

const VIEWS: { id: ExploreView; label: string; icon: React.ElementType }[] = [
  { id: "sql", label: "SQL", icon: Terminal },
  { id: "docs", label: "Docs", icon: FileText },
  { id: "dashboards", label: "Dashboards", icon: Boxes },
]

export default function ExplorePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [docsStatus, setDocsStatus] = useState<DocsStatus>("idle")
  const [docsError, setDocsError] = useState<string | null>(null)
  const [docsUrl, setDocsUrl] = useState<string | null>(null)
  const [view, setView] = useState<ExploreView>("sql")
  const [addition, setAddition] = useState<BoardAddition | null>(null)
  const [boardDirty, setBoardDirty] = useState(false)
  const consumeAddition = useCallback(() => setAddition(null), [])

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
      <h1 className="sr-only">Explore</h1>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
        <select aria-label="Project" title={selectedProject?.description || "Select project"} value={selectedProjectId ?? ""} disabled={projectsLoading} onChange={event => { if (boardDirty && !window.confirm('Discard unsaved dashboard changes and switch project?')) return; setBoardDirty(false); setAddition(null); setSelectedProjectId(event.target.value || null) }} className="h-8 w-44 min-w-0 max-w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-800 sm:w-52">
          <option value="" disabled>{projectsLoading ? "Loading projects…" : "Select a project"}</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <nav aria-label="Explore sections" className="flex items-center gap-1">
          {VIEWS.map(item => <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => setView(item.id)}
            className={cn("flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium", view === item.id ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:bg-slate-100")}>
            <item.icon className="h-3.5 w-3.5" />{item.label}
          </button>)}
        </nav>
        {view === "docs" && <div className="ml-auto flex items-center gap-2">
          {busy && <span role="status" className="flex items-center gap-1 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />{docsStatus === "generating" ? "Generating…" : "Loading…"}</span>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label="Docs actions" title="Docs actions" disabled={!selectedProject}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={busy} onSelect={() => selectedProject && checkDocs(selectedProject.id)}><RefreshCw className="mr-2 h-4 w-4" />Refresh documentation</DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onSelect={generateDocs}><FileText className="mr-2 h-4 w-4" />Generate Docs</DropdownMenuItem>
              {docsUrl && <DropdownMenuItem asChild><a href={docsUrl} target="_blank" rel="noreferrer"><ExternalLink className="mr-2 h-4 w-4" />Open in new tab</a></DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>}
      </div>
      {projectsError && <div role="alert" className="flex items-center gap-2 bg-red-50 px-3 py-2 text-xs text-red-700">{projectsError}<Button variant="ghost" size="sm" onClick={loadProjects}>Retry</Button></div>}
      <div className="min-h-0 flex-1">
        {selectedProject && <>
          <div className={view === 'sql' ? 'h-full' : 'hidden'}><SqlConsole key={selectedProject.id} projectId={selectedProject.id} onAddToDashboard={item => { setAddition(item); setView('dashboards') }} /></div>
          <div className={view === 'dashboards' ? 'h-full' : 'hidden'}><DashboardWorkspace key={selectedProject.id} projectId={selectedProject.id} addition={addition} onConsumed={consumeAddition} onDirty={setBoardDirty} /></div>
        </>}
        {!selectedProject ? <div className="flex h-full items-center justify-center p-4"><EmptyState icon={FileText} title={projectsLoading ? "Loading projects…" : "No project selected"} description="Choose a project above to explore its data." /></div>
          : view !== 'docs' ? null
          : docsUrl && docsStatus === "ready" ? <iframe key={docsUrl} src={docsUrl} title={`${selectedProject.name} docs`} className="h-full w-full border-0" />
          : <div className="flex h-full items-center justify-center p-4">
            {busy ? <Loader2 aria-label="Loading documentation" className="h-5 w-5 animate-spin text-blue-600" />
              : docsStatus === "missing" ? <EmptyState icon={FileText} title="Docs not generated" description="Generate documentation for this project to browse models and lineage." action={<Button size="sm" onClick={generateDocs}>Generate Docs</Button>} />
              : docsStatus === "error" ? <EmptyState icon={AlertCircle} title="Unable to load docs" description={docsError || "Check the project documentation output."} action={<Button size="sm" variant="outline" onClick={() => checkDocs(selectedProject.id)}>Retry</Button>} />
              : null}
          </div>}
      </div>
    </div>
  )
}
