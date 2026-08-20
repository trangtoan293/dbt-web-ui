"use client"

import React, { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  Activity,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Circle,
  Clock3,
  Code2,
  Database,
  GitBranch,
  Layers3,
  PlayCircle,
  Plus,
  Rocket,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react"
import { getConnections, getProjects } from "@/lib/api-client"
import { useGlobal } from "@/lib/context/GlobalContext"
import { Button } from "@/components-v2/ui/button"
import { Card, CardContent } from "@/components-v2/ui/card"

interface LatestProjectRun {
  id: string
  status: string
  command: string
  selector: string | null
  modelsTotal: number | null
  modelsSuccess: number | null
  modelsError: number | null
  createdAt: string
  completedAt: string | null
}

interface DbtProject {
  id: string
  name: string
  description: string | null
  git_branch: string | null
  sync_status: string | null
  created_at: string | null
  updated_at: string | null
  connection_id: string | null
  dremio_source_id: string | null
  connection?: {
    name?: string | null
    connectionType?: string | null
  } | null
  dremioSource?: {
    name?: string | null
  } | null
  _count?: {
    runs: number
  }
  runs?: LatestProjectRun[]
}

interface Connection {
  id: string
}

const statusStyle: Record<string, { label: string; className: string; dot: string }> = {
  synced: { label: "Ready", className: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  syncing: { label: "Syncing", className: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  error: { label: "Needs attention", className: "bg-red-50 text-red-700", dot: "bg-red-500" },
  pending: { label: "Pending", className: "bg-amber-50 text-amber-700", dot: "bg-amber-500" },
}

function getStatus(status: string | null) {
  return statusStyle[status || "pending"] || statusStyle.pending
}

function formatRelativeDate(value: string | null) {
  if (!value) return "Recently"
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return "Recently"
  const diff = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(value).toLocaleDateString()
}

function getProjectModelCount(project: DbtProject) {
  const latestRun = project.runs?.[0]
  const isFullRun = latestRun && !latestRun.selector && ["run", "build", "compile"].includes(latestRun.command)
  return isFullRun ? latestRun.modelsTotal || 0 : 0
}

function getConnectionLabel(project: DbtProject) {
  if (project.connection) {
    return {
      title: project.connection.name || "Configured",
      detail: project.connection.connectionType || "Connection",
    }
  }
  if (project.dremioSource) {
    return {
      title: project.dremioSource.name || "Dremio source",
      detail: "Dremio source",
    }
  }
  if (project.connection_id || project.dremio_source_id) {
    return {
      title: "Configured",
      detail: "Connection linked",
    }
  }
  return {
    title: "Not configured",
    detail: "No connection",
  }
}

export default function DashboardOverview() {
  const { user } = useGlobal()
  const [projects, setProjects] = useState<DbtProject[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [projectRows, connectionRows] = await Promise.all([
          getProjects(false),
          getConnections(),
        ])
        setProjects(Array.isArray(projectRows) ? projectRows : [])
        setConnections(Array.isArray(connectionRows) ? connectionRows : [])
      } catch (error) {
        console.error("Failed to load dashboard", error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const recentProjects = useMemo(
    () =>
      [...projects]
        .sort((a, b) => {
          const aDate = new Date(a.updated_at || a.created_at || 0).getTime()
          const bDate = new Date(b.updated_at || b.created_at || 0).getTime()
          return bDate - aDate
        })
        .slice(0, 5),
    [projects]
  )
  const readyProjects = projects.filter((project) => project.sync_status === "synced").length
  const issueProjects = projects.filter((project) => project.sync_status === "error").length
  const pendingProjects = projects.length - readyProjects - issueProjects
  const totalModels = projects.reduce((total, project) => total + getProjectModelCount(project), 0)
  const totalRuns = projects.reduce((total, project) => total + (project._count?.runs || 0), 0)
  const connectedProjects = projects.filter((project) => project.connection_id || project.dremio_source_id).length
  const branches = new Set(projects.map((project) => project.git_branch || "main")).size
  const connectionCoverage = projects.length ? Math.round((connectedProjects / projects.length) * 100) : 0
  const healthyRate = projects.length ? Math.round((readyProjects / projects.length) * 100) : 0
  const firstName = user?.name?.split(" ")[0] || user?.email?.split("@")[0] || "there"

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 pb-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#0078D4]">Overview</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-950 sm:text-3xl">Welcome back, {firstName}</h1>
          <p className="mt-1 text-sm text-gray-500">Monitor your dbt workspace and continue developing models.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/develop">
            <Button variant="outline"><Code2 /> Open IDE</Button>
          </Link>
          <Link href="/develop/new">
            <Button><Plus /> New Project</Button>
          </Link>
        </div>
      </header>

      <section className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard icon={Layers3} label="Projects" value={projects.length} note={`${readyProjects} ready`} tone="blue" />
          <MetricCard icon={PlayCircle} label="Runs" value={totalRuns} note="Persisted dbt runs" tone="purple" />
          <MetricCard icon={Database} label="Models" value={totalModels} note="Cataloged or full-run count" tone="teal" />
          <MetricCard icon={ShieldCheck} label="Ready" value={`${healthyRate}%`} note={issueProjects ? `${issueProjects} with errors` : "No sync errors"} tone="green" />
        </div>
        <WorkspaceSnapshot
          connectedProjects={connectedProjects}
          totalProjects={projects.length}
          connectionCoverage={connectionCoverage}
          branches={branches}
          pendingProjects={pendingProjects}
          issueProjects={issueProjects}
        />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.85fr)]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div>
              <h2 className="font-semibold text-gray-950">Your projects</h2>
              <p className="mt-0.5 text-xs text-gray-500">Jump back into your most recently updated dbt projects.</p>
            </div>
            <Link href="/develop" className="flex items-center gap-1 text-sm font-medium text-[#0078D4] hover:underline">
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          {loading ? (
            <ProjectSkeleton />
          ) : recentProjects.length ? (
            <div className="divide-y divide-gray-100">
              {recentProjects.map((project) => <ProjectRow key={project.id} project={project} />)}
            </div>
          ) : (
            <EmptyProjects />
          )}
        </Card>

        <div className="space-y-5">
          <QuickActions />
          <SetupChecklist projects={projects.length} connections={connections.length} />
        </div>
      </section>

      <ProjectPortfolio projects={projects} />

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
        <RecentActivity projects={recentProjects} />

        <Card className="overflow-hidden border-[#D8E8F5] bg-gradient-to-br from-[#F3F9FD] to-white">
          <CardContent className="p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#0078D4] text-white shadow-sm">
              <Sparkles className="h-5 w-5" />
            </div>
            <h2 className="mt-4 font-semibold text-gray-950">Develop with confidence</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Open a project to edit models, preview results, inspect lineage, and run dbt commands from one workspace.
            </p>
            <Link href="/develop" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-[#0078D4] hover:underline">
              Go to Develop <ArrowRight className="h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, note, tone }: { icon: React.ElementType; label: string; value: number | string; note: string; tone: "blue" | "teal" | "green" | "purple" }) {
  const tones = {
    blue: "bg-blue-50 text-blue-600",
    teal: "bg-teal-50 text-teal-600",
    green: "bg-emerald-50 text-emerald-600",
    purple: "bg-violet-50 text-violet-600",
  }
  return (
    <Card className="min-h-32">
      <CardContent className="flex min-h-32 flex-col justify-between p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-semibold leading-5 text-gray-600">{label}</p>
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone]}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-3xl font-semibold leading-9 text-gray-950">{value}</p>
          <p className="truncate text-sm leading-5 text-gray-500">{note}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function WorkspaceSnapshot({
  connectedProjects,
  totalProjects,
  connectionCoverage,
  branches,
  pendingProjects,
  issueProjects,
}: {
  connectedProjects: number
  totalProjects: number
  connectionCoverage: number
  branches: number
  pendingProjects: number
  issueProjects: number
}) {
  const items = [
    { icon: Server, label: "Connection coverage", value: `${connectedProjects}/${totalProjects}`, note: `${connectionCoverage}% configured` },
    { icon: GitBranch, label: "Active branches", value: branches, note: "Unique branches" },
    { icon: Clock3, label: "Pending sync", value: pendingProjects, note: "Not ready yet" },
    { icon: TriangleAlert, label: "Needs attention", value: issueProjects, note: "Sync errors" },
  ]

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold leading-6 text-gray-950">Workspace snapshot</h2>
          <Activity className="h-4 w-4 text-gray-400" />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          {items.map(({ icon: Icon, label, value, note }) => (
            <div key={label} className="min-h-24 rounded-lg border border-gray-100 bg-gray-50/70 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold leading-5 text-gray-500">
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
              </div>
              <p className="mt-2 text-xl font-semibold leading-7 text-gray-950">{value}</p>
              <p className="mt-0.5 truncate text-sm leading-5 text-gray-500">{note}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function ProjectRow({ project }: { project: DbtProject }) {
  const status = getStatus(project.sync_status)
  return (
    <Link href={`/develop/${project.id}`} className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-gray-50">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50"><Database className="h-5 w-5 text-teal-600" /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-gray-950 group-hover:text-[#0078D4]">{project.name}</p>
        <p className="mt-0.5 truncate text-xs text-gray-500">{project.description || "dbt transformation project"}</p>
      </div>
      <span className="hidden items-center gap-1.5 text-xs text-gray-500 sm:flex"><GitBranch className="h-3.5 w-3.5" />{project.git_branch || "main"}</span>
      <span className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium md:flex ${status.className}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />{status.label}
      </span>
      <span className="hidden w-16 text-right text-xs text-gray-400 lg:block">{formatRelativeDate(project.updated_at || project.created_at)}</span>
      <ArrowRight className="h-4 w-4 text-gray-300 transition-transform group-hover:translate-x-0.5 group-hover:text-[#0078D4]" />
    </Link>
  )
}

function ProjectPortfolio({ projects }: { projects: DbtProject[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="font-semibold text-gray-950">Project portfolio</h2>
          <p className="mt-0.5 text-xs text-gray-500">Active projects, catalog status, and recorded workspace metadata.</p>
        </div>
        <BarChart3 className="h-5 w-5 text-gray-400" />
      </div>
      {projects.length ? (
        <div className="p-3">
          <div className="overflow-x-auto rounded-lg border border-gray-100">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50/80 text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2.5">Project</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Branch</th>
                  <th className="px-4 py-3">Connection</th>
                  <th className="px-4 py-3">Models</th>
                  <th className="px-4 py-3">Runs</th>
                  <th className="px-4 py-3">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {projects.map((project) => {
                  const status = getStatus(project.sync_status)
                  const connection = getConnectionLabel(project)
                  const modelCount = getProjectModelCount(project)
                  const runCount = project._count?.runs || 0
                  return (
                    <tr key={project.id} className="hover:bg-gray-50/80">
                      <td className="px-4 py-3">
                        <Link href={`/develop/${project.id}`} className="font-medium text-gray-950 hover:text-[#0078D4] hover:underline">{project.name}</Link>
                        <p className="mt-0.5 max-w-[240px] truncate text-xs text-gray-500">{project.description || "dbt transformation project"}</p>
                      </td>
                      <td className="px-4 py-3"><StatusBadge status={status} /></td>
                      <td className="px-4 py-3 text-xs font-medium text-gray-600">{project.git_branch || "main"}</td>
                      <td className="px-4 py-3">
                        <p className="text-xs font-medium text-gray-700">{connection.title}</p>
                        <p className="mt-0.5 text-xs text-gray-400">{connection.detail}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-700">{modelCount}</p>
                        <p className="mt-0.5 text-xs text-gray-400">{modelCount ? "Cataloged" : "Not cataloged"}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-700">{runCount}</p>
                        <p className="mt-0.5 text-xs text-gray-400">{runCount ? "Recorded" : "No records"}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{formatRelativeDate(project.updated_at || project.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : <p className="px-5 py-8 text-center text-sm text-gray-500">Project metrics will appear after you create a project.</p>}
    </Card>
  )
}

function StatusBadge({ status }: { status: { label: string; className: string; dot: string } }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}><span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />{status.label}</span>
}

function QuickActions() {
  const actions = [
    { href: "/develop/new", icon: Plus, title: "Create project", note: "Initialize or clone a repository" },
    { href: "/connections", icon: Server, title: "Manage connections", note: "Configure your query engines" },
    { href: "/runs", icon: Rocket, title: "Review history", note: "Inspect run history and jobs" },
    { href: "/settings", icon: Settings2, title: "Workspace settings", note: "Manage your preferences" },
  ]
  return (
    <Card>
      <div className="border-b border-gray-100 px-5 py-4">
        <h2 className="font-semibold text-gray-950">Quick actions</h2>
        <p className="mt-0.5 text-xs text-gray-500">Common workspace tasks.</p>
      </div>
      <div className="grid gap-2 p-3">
        {actions.map(({ href, icon: Icon, title, note }) => (
          <Link key={href} href={href} className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-gray-50">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 group-hover:bg-blue-50">
              <Icon className="h-4 w-4 text-gray-500 group-hover:text-[#0078D4]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-800">{title}</p>
              <p className="truncate text-xs text-gray-500">{note}</p>
            </div>
            <ArrowRight className="h-4 w-4 text-gray-300 group-hover:text-[#0078D4]" />
          </Link>
        ))}
      </div>
    </Card>
  )
}

function RecentActivity({ projects }: { projects: DbtProject[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="font-semibold text-gray-950">Recent activity</h2>
          <p className="mt-0.5 text-xs text-gray-500">Latest workspace updates from your projects.</p>
        </div>
        <Activity className="h-5 w-5 text-gray-400" />
      </div>
      <CardContent className="p-3">
        {projects.length ? (
          <div className="space-y-2">
            {projects.slice(0, 4).map((project, index) => (
              <div key={project.id} className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50">
                  <GitBranch className="h-3.5 w-3.5 text-[#0078D4]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-700"><span className="font-medium text-gray-950">{project.name}</span> workspace updated</p>
                  <p className="mt-0.5 truncate text-xs text-gray-500">{project.git_branch || "main"} branch · {formatRelativeDate(project.updated_at || project.created_at)}</p>
                </div>
                {index === 0 && <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-[#0078D4]">Latest</span>}
              </div>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-gray-500">Project activity will appear here.</p>
        )}
      </CardContent>
    </Card>
  )
}

function SetupChecklist({ projects, connections }: { projects: number; connections: number }) {
  const items = [
    { done: connections > 0, text: "Configure a data connection" },
    { done: projects > 0, text: "Create or import a dbt project" },
    { done: false, text: "Run and validate your first model" },
  ]
  const completed = items.filter((item) => item.done).length
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-950">Workspace setup</h2>
          <span className="text-xs font-medium text-gray-500">{completed}/{items.length}</span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-[#0078D4]" style={{ width: `${(completed / items.length) * 100}%` }} /></div>
        <div className="mt-4 space-y-3">
          {items.map((item) => (
            <div key={item.text} className="flex items-center gap-2 text-sm">
              {item.done ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Circle className="h-4 w-4 text-gray-300" />}
              <span className={item.done ? "text-gray-500 line-through" : "text-gray-700"}>{item.text}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function ProjectSkeleton() {
  return <div className="space-y-px">{[1, 2, 3, 4].map((item) => <div key={item} className="h-[68px] animate-pulse bg-gray-50" />)}</div>
}

function EmptyProjects() {
  return (
    <div className="flex flex-col items-center px-5 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50"><Database className="h-6 w-6 text-[#0078D4]" /></div>
      <h3 className="mt-3 font-semibold text-gray-950">Create your first dbt project</h3>
      <p className="mt-1 max-w-sm text-sm text-gray-500">Initialize a new workspace or clone an existing Git repository to start developing models.</p>
      <Link href="/develop/new" className="mt-4"><Button size="sm"><Plus /> New Project</Button></Link>
    </div>
  )
}
