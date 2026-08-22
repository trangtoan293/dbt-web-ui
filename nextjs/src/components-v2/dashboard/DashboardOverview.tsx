"use client"

import React, { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  ArrowRight,
  CheckCircle2,
  Circle,
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
} from "lucide-react"
import { getConnections, getProjects } from "@/lib/api-client"
import { useGlobal } from "@/lib/context/GlobalContext"
import { Button } from "@/components-v2/ui/button"
import { Card, CardContent } from "@/components-v2/ui/card"

interface LatestProjectRun {
  command: string
  selector: string | null
  modelsTotal: number | null
}

interface DbtProject {
  id: string
  name: string
  description: string | null
  git_branch: string | null
  sync_status: string | null
  created_at: string | null
  updated_at: string | null
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
  const totalModels = projects.reduce((total, project) => total + getProjectModelCount(project), 0)
  const totalRuns = projects.reduce((total, project) => total + (project._count?.runs || 0), 0)
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
          <Button variant="outline" asChild><Link href="/develop"><Code2 /> Open IDE</Link></Button>
          <Button asChild><Link href="/develop/new"><Plus /> New Project</Link></Button>
        </div>
      </header>

      {loading ? (
        <DashboardSkeleton />
      ) : projects.length === 0 ? (
        <GettingStarted connectionCount={connections.length} />
      ) : (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={Layers3} label="Projects" value={projects.length} note={`${readyProjects} ready`} tone="blue" />
            <MetricCard icon={PlayCircle} label="Runs" value={totalRuns} note="Persisted dbt runs" tone="purple" />
            <MetricCard icon={Database} label="Models" value={totalModels} note="Cataloged or full-run count" tone="teal" />
            <MetricCard icon={ShieldCheck} label="Ready" value={`${healthyRate}%`} note={issueProjects ? `${issueProjects} with errors` : "No sync errors"} tone="green" />
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
              <div className="divide-y divide-gray-100">
                {recentProjects.map((project) => <ProjectRow key={project.id} project={project} />)}
              </div>
            </Card>

            <div className="space-y-5">
              <SetupChecklist projects={projects.length} connections={connections.length} runs={totalRuns} />
              <QuickActions />
            </div>
          </section>
        </>
      )}
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
    <Card className="min-h-32 transition-[border-color,box-shadow] hover:border-slate-300 hover:shadow-md">
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

function QuickActions() {
  const actions = [
    { href: "/develop/new", icon: Plus, title: "Create project", note: "Initialize or clone a repository" },
    { href: "/data", icon: Server, title: "Manage connections", note: "Configure your query engines" },
    { href: "/orchestrate", icon: Rocket, title: "Review history", note: "Inspect run history and jobs" },
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

function SetupChecklist({ projects, connections, runs }: { projects: number; connections: number; runs: number }) {
  const items = [
    { done: connections > 0, text: "Configure a data connection" },
    { done: projects > 0, text: "Create or import a dbt project" },
    { done: runs > 0, text: "Run and validate your first model" },
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

function DashboardSkeleton(): React.ReactElement {
  return (
    <div className="space-y-5" aria-label="Loading workspace overview">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((item) => <div key={item} className="h-32 animate-pulse rounded-xl border border-slate-200 bg-white/70" />)}
      </div>
      <Card className="overflow-hidden"><ProjectSkeleton /></Card>
    </div>
  )
}

function GettingStarted({ connectionCount }: { connectionCount: number }): React.ReactElement {
  const steps = [
    {
      icon: Server,
      title: "Connect your warehouse",
      description: connectionCount > 0 ? `${connectionCount} connection${connectionCount === 1 ? "" : "s"} ready to use.` : "Add PostgreSQL, DuckDB, Dremio, Oracle, or Spark.",
      href: "/data",
      action: connectionCount > 0 ? "Review connections" : "Add connection",
      done: connectionCount > 0,
    },
    {
      icon: Code2,
      title: "Create or import a project",
      description: "Start fresh or clone an existing dbt repository.",
      href: "/develop/new",
      action: "Create project",
      done: false,
    },
    {
      icon: PlayCircle,
      title: "Build your first model",
      description: "Develop, preview, and run models with live logs.",
      href: "/develop",
      action: "Open Develop",
      done: false,
    },
  ]

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden border-blue-200/70">
        <CardContent className="relative overflow-hidden bg-gradient-to-br from-[#F3F9FD] via-white to-[#F1FBFA] p-6 sm:p-8">
          <div aria-hidden="true" className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-sky-200/30 blur-3xl" />
          <div className="relative max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/80 px-3 py-1 text-xs font-semibold text-[#0078D4] shadow-sm">
              <Sparkles className="h-3.5 w-3.5" /> Start here
            </div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-950 sm:text-3xl">Build your first dbt workspace</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-gray-600 sm:text-base">
              Connect your data platform, bring in a project, and run a model—all from one browser workspace.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Button asChild><Link href="/develop/new"><Plus /> Create Project</Link></Button>
              <Button variant="outline" asChild><Link href="/data"><Server /> Manage Connections</Link></Button>
            </div>
          </div>
        </CardContent>

        <div className="grid divide-y divide-slate-100 bg-white md:grid-cols-3 md:divide-x md:divide-y-0">
          {steps.map(({ icon: Icon, title, description, href, action, done }, index) => (
            <Link key={title} href={href} className="group p-5 transition-colors hover:bg-slate-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0078D4]">
              <div className="flex items-center justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-600 transition-colors group-hover:bg-blue-50 group-hover:text-[#0078D4]">
                  <Icon className="h-5 w-5" />
                </div>
                {done ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Ready</span>
                ) : (
                  <span className="text-xs font-semibold text-slate-400">Step {index + 1}</span>
                )}
              </div>
              <h3 className="mt-4 text-sm font-semibold text-gray-950">{title}</h3>
              <p className="mt-1 min-h-10 text-sm leading-5 text-gray-500">{description}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-[#0078D4]">{action}<ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
          ))}
        </div>
      </Card>

      <QuickActions />
    </div>
  )
}
