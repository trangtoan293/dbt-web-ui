export type RunStatus = "pending" | "running" | "success" | "error" | "cancelled" | string

export type DbtRunArtifact = {
  id: string
  uniqueId: string
  status: string
  executionTime: number | null
  compiledCode: string | null
  error: string | null
  timing: unknown
}

export type DbtRun = {
  id: string
  projectId: string
  command: string
  selector: string | null
  status: RunStatus
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  modelsTotal: number | null
  modelsSuccess: number | null
  modelsError: number | null
  logs?: string | null
  errorMessage: string | null
  results?: unknown
  gitCommit: string | null
  createdAt: string
  project?: { id: string; name: string }
  artifacts?: DbtRunArtifact[]
  _count?: { artifacts: number }
}

export type RunLogDashboardResponse = {
  items: DbtRun[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
  summary: {
    total: number
    success: number
    error: number
    cancelled: number
    running: number
    pending: number
    averageDurationMs: number | null
  }
  facets: {
    projects: Array<{ id: string; name: string }>
  }
}

export type DbtRunStreamEvent =
  | { type: "started"; command?: string }
  | { type: "output"; line: string }
  | { type: "completed"; returncode?: number; status?: string }
  | { type: "error"; error: string }
  | { type: "ping" }
