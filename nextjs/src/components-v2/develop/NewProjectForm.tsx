"use client"

import React, { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertCircle, ArrowLeft, Check, Database, GitBranch, Loader2 } from "lucide-react"
import { dbtApi, gitApi } from "@/lib/api"
import { createProject, updateProject } from "@/lib/api-client"
import { Button } from "@/components-v2/ui/button"
import { Card } from "@/components-v2/ui/card"
import { Input } from "@/components-v2/ui/input"
import { Textarea } from "@/components-v2/ui/textarea"

interface AnyConnection {
  id: string
  name: string
  connectionType: string
  host: string
  _sourceTable: "connection" | "dremio_source"
}

const TYPE_LABELS: Record<string, string> = {
  postgresql: "PostgreSQL",
  duckdb: "DuckDB",
  dremio: "Dremio",
  oracle: "Oracle",
  spark: "Apache Spark",
}

type CreationStep = "idle" | "creating" | "initializing" | "cloning" | "failed"

function getErrorMessage(error: unknown): string {
  let message = ""
  if (error instanceof Error) message = error.message
  if (error && typeof error === "object") {
    const apiError = error as { message?: unknown; details?: { detail?: unknown; message?: unknown; error?: unknown } }
    const detail = apiError.details?.detail ?? apiError.details?.message ?? apiError.details?.error
    if (typeof detail === "string" && detail.trim()) message = detail
    else if (typeof apiError.message === "string" && apiError.message.trim()) message = apiError.message
  }

  if (message.includes("could not read Username")) {
    return "GitLab requires credentials for this repository. Enter your GitLab username and a Personal Access Token with read_repository permission, then try again."
  }
  if (message.includes("Authentication failed")) {
    return "Git authentication failed. Check that your GitLab username and Personal Access Token are correct and have read_repository permission."
  }
  if (message.includes("Remote branch") || message.includes("not found")) {
    return "Git clone failed. Check that the repository URL and branch name are correct."
  }

  return message || "Failed to create project"
}

function getStepMessage(step: CreationStep): string {
  switch (step) {
    case "creating":
      return "Creating project..."
    case "initializing":
      return "Initializing dbt project..."
    case "cloning":
      return "Cloning Git repository..."
    case "failed":
      return "Project setup stopped."
    default:
      return ""
  }
}

export default function NewProjectForm() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [creationStep, setCreationStep] = useState<CreationStep>("idle")
  const [connections, setConnections] = useState<AnyConnection[]>([])
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    project_type: "git_clone" as "git_clone" | "dbt_init",
    git_url: "",
    git_branch: "main",
    git_username: "",
    git_token: "",
    selected_connection_id: "",
    selected_connection_source: "" as "connection" | "dremio_source" | "",
    raw_layer_dir: "models/raw",
    staging_dir: "models/staging",
    business_dir: "models/marts",
  })

  useEffect(() => {
    fetch("/api/connections")
      .then((r) => r.json())
      .then((data) => setConnections(Array.isArray(data) ? data : []))
      .catch((e) => console.error("Error loading connections:", e))
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError("")
    setCreationStep("creating")

    if (formData.project_type === "git_clone") {
      if (!formData.git_url.trim()) {
        setCreationStep("failed")
        setError("Repository URL is required.")
        return
      }
      if (!formData.git_username.trim() || !formData.git_token.trim()) {
        setCreationStep("failed")
        setError("Git username and PAT are required before creating a project from a repository.")
        return
      }
    }

    setLoading(true)

    try {
      const connectionPayload =
        formData.selected_connection_source === "dremio_source"
          ? { dremioSourceId: formData.selected_connection_id }
          : formData.selected_connection_source === "connection"
          ? { connectionId: formData.selected_connection_id }
          : {}

      const project = await createProject({
        name: formData.name.trim(),
        description: formData.description.trim() || undefined,
        gitUrl: formData.git_url.trim() || undefined,
        gitBranch: formData.git_branch.trim() || "main",
        stagingDir: formData.staging_dir,
        martsDir: formData.business_dir,
        syncStatus: "pending",
        ...connectionPayload,
      })
      const projectId = project.id
      const projectName = formData.name.trim().toLowerCase().replace(/\s+/g, "_")

      if (formData.project_type === "dbt_init") {
        try {
          setCreationStep("initializing")
          await updateProject(projectId, { syncStatus: "syncing" })
          const initResult = await dbtApi.init(projectId, projectName)
          await updateProject(projectId, { syncStatus: initResult.success ? "synced" : "error" })
        } catch (initError) {
          console.error("dbt init error:", initError)
          await updateProject(projectId, { syncStatus: "error" })
          setCreationStep("failed")
          setError(getErrorMessage(initError))
          return
        }
      } else if (formData.git_url.trim()) {
        try {
          setCreationStep("cloning")
          await updateProject(projectId, { syncStatus: "syncing" })
          const cloneResult = await gitApi.clone(
            projectId,
            formData.git_url.trim(),
            formData.git_branch.trim() || "main",
            formData.git_username.trim() || undefined,
            formData.git_token.trim() || undefined
          )
          await updateProject(projectId, { syncStatus: cloneResult.success ? "synced" : "error" })
        } catch (cloneError) {
          console.error("Git clone error:", cloneError)
          await updateProject(projectId, { syncStatus: "error" })
          setCreationStep("failed")
          setError(getErrorMessage(cloneError))
          return
        }
      }

      router.push(`/develop/${projectId}`)
    } catch (submitError) {
      setCreationStep("failed")
      setError(getErrorMessage(submitError))
    } finally {
      setLoading(false)
      if (!error) {
        setCreationStep("idle")
      }
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/develop" className="rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">New dbt Project</h1>
          <p className="mt-1 text-sm text-gray-500">Create a new transformation project</p>
        </div>
      </div>

      <Card>
        <form onSubmit={handleSubmit}>
          <FormSection icon={<Database className="h-5 w-5 text-[#038387]" />} title="Project Information">
            <Field label="Project Name" required>
              <Input value={formData.name} onChange={(event) => setFormData({ ...formData, name: event.target.value })} placeholder="e.g., finance-analytics" required />
            </Field>
            <Field label="Description">
              <Textarea value={formData.description} onChange={(event) => setFormData({ ...formData, description: event.target.value })} placeholder="Optional description..." rows={2} />
            </Field>
          </FormSection>

          <FormSection icon={<GitBranch className="h-5 w-5 text-[#0078D4]" />} title="Project Source">
            <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
              <RadioOption checked={formData.project_type === "git_clone"} label="Clone from Git repository" onChange={() => setFormData({ ...formData, project_type: "git_clone" })} />
              <RadioOption checked={formData.project_type === "dbt_init"} label="Create new project (dbt init)" onChange={() => setFormData({ ...formData, project_type: "dbt_init" })} />
            </div>
            {formData.project_type === "git_clone" && (
              <>
                <Field label="Repository URL" required>
                  <Input type="url" value={formData.git_url} onChange={(event) => setFormData({ ...formData, git_url: event.target.value })} placeholder="https://github.com/org/dbt-project.git" required />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Username" required>
                    <Input value={formData.git_username} onChange={(event) => setFormData({ ...formData, git_username: event.target.value })} placeholder="your-username" autoComplete="username" required />
                  </Field>
                  <Field label="Token / PAT" required>
                    <Input type="password" value={formData.git_token} onChange={(event) => setFormData({ ...formData, git_token: event.target.value })} placeholder="ghp_..." autoComplete="current-password" required />
                  </Field>
                </div>
              </>
            )}
            <Field label="Branch">
              <Input value={formData.git_branch} onChange={(event) => setFormData({ ...formData, git_branch: event.target.value })} />
            </Field>
          </FormSection>

          <FormSection icon={<Database className="h-5 w-5 text-[#038387]" />} title="Connection" last>
            <Field label="Query Engine">
              <select
                value={formData.selected_connection_id}
                onChange={(event) => {
                  const id = event.target.value
                  const conn = connections.find((c) => c.id === id)
                  setFormData({
                    ...formData,
                    selected_connection_id: id,
                    selected_connection_source: conn ? conn._sourceTable : "",
                  })
                }}
                className="flex h-9 w-full rounded-md border border-gray-300 bg-white px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4] focus-visible:ring-offset-2"
              >
                <option value="">No connection (manual profiles.yml)</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({TYPE_LABELS[c.connectionType] ?? c.connectionType}{c.host ? ` — ${c.host}` : ""})
                  </option>
                ))}
              </select>
              {connections.length === 0 && (
                <p className="mt-1 text-xs text-gray-500">
                  No connections configured. <Link href="/connections" className="text-[#0078D4] hover:underline">Add one</Link>
                </p>
              )}
            </Field>
          </FormSection>

          {error && (
            <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">{getStepMessage(creationStep) || "Project setup failed."}</div>
                  <div className="mt-1 whitespace-pre-wrap break-words">{error}</div>
                </div>
              </div>
            </div>
          )}

          {loading && creationStep !== "idle" && (
            <div className="mx-6 mt-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              {getStepMessage(creationStep)}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 p-6">
            <Link href="/develop"><Button type="button" variant="outline">Cancel</Button></Link>
            <Button type="submit" disabled={loading || !formData.name.trim()}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {loading ? "Creating..." : "Create Project"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}

function FormSection({ icon, title, children, last = false }: { icon: React.ReactNode; title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <section className={`space-y-4 p-6 ${last ? "" : "border-b border-gray-200"}`}>
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-medium text-gray-900">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Field({ label, required = false, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-gray-700">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
    </div>
  )
}

function RadioOption({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
      <input type="radio" name="project_type" checked={checked} onChange={onChange} className="h-4 w-4 text-[#0078D4]" />
      {label}
    </label>
  )
}
