"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  ArrowLeft,
  ChevronDown,
  Database,
  Edit,
  FolderTree,
  GitBranch,
  History,
  KeyRound,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import {
  getProjectById,
  updateProject,
  softDeleteProject,
  hardDeleteProject,
} from "@/lib/api-client";
import { filesApi, dbtApi, gitApi, envVarsApi } from "@/lib/api";
import { getDbtRunnerUrl } from "@/lib/api/client";
import { buildDbtAdditionalArgs, buildDbtCommandWithArgs } from "@/lib/dbt-command-args";
import { clearLegacyDevelopSession, loadDevelopSession, saveDevelopSession, type DevelopSessionState } from "@/lib/develop-session";
import {
  useFileWatcher,
  useDbtIntellisense,
  type FileWatcherEvent,
} from "@/lib/hooks";
import { useDbtRunStream } from "@/lib/hooks/useDbtRunStream";
import { useAgentAvailability } from "@/lib/hooks/useAgentAvailability";

import {
  FileExplorer,
  EditorTabs,
  TerminalPanel,
  RightPanel,
} from "@/components-v2/develop/transforms";
import { formatFile } from "@/components-v2/develop/workspace/CodeEditor";
import AgentPanel from "@/components-v2/develop/agent/AgentPanel";
import SourceControlPanel from "@/components-v2/develop/workspace/SourceControlPanel";
import CommitHistory from "@/components-v2/develop/workspace/CommitHistory";
import { GitCredentialDialog } from "@/components-v2/develop/git";
import { DeleteProjectDialog } from "@/components-v2/develop/transforms/DeleteProjectDialog";
import { HardDeleteProjectDialog } from "@/components-v2/develop/transforms/HardDeleteProjectDialog";
import { RestoreProjectDialog } from "@/components-v2/develop/transforms/RestoreProjectDialog";
import { Button } from "@/components-v2/ui/button";
import { Input } from "@/components-v2/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components-v2/ui/dropdown-menu";
import ProjectSettingsDialog from "@/components-v2/develop/settings/ProjectSettingsDialog";
import type { DbtEnvironmentVariable, ProjectSettingsTab } from "@/components-v2/develop/settings/types";
import TargetSelector, { DEFAULT_DBT_TARGET } from "@/components-v2/develop/TargetSelector";
import { useTopBar } from "@/components-v2/layout/TopBarContext";
import type { Connection } from "@/components-v2/develop/types";

interface DbtProject {
  id: string;
  name: string;
  description: string | null;
  git_url: string | null;
  git_branch: string;
  git_project_subdirectory?: string | null;
  sync_status: string;
  last_synced_at: string | null;
  raw_layer_dir: string;
  staging_dir: string;
  business_dir: string;
  dremio_source_id: string | null;
  connection_id: string | null;
  deleted_at?: string | null;
}

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

interface OpenTab {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  isDraft?: boolean;
}

type TerminalTabType = "results" | "lineage" | "compiled" | "queryPlan" | "logs";
type QueryPanelView = "results" | "plan";
type SidebarTabType = "files" | "git" | "history";
interface DevelopLayoutProps {
  projectId: string;
}

const renamePath = (path: string, oldPath: string, newPath: string) => {
  if (path === oldPath) return newPath;
  if (path.startsWith(oldPath + "/")) return newPath + path.slice(oldPath.length);
  return path;
};

const renameNodes = (nodes: FileNode[], oldPath: string, newPath: string): FileNode[] =>
  nodes.map((node) => {
    const path = renamePath(node.path, oldPath, newPath);
    return {
      ...node,
      path,
      name: path.split("/").pop() || path,
      children: node.children ? renameNodes(node.children, oldPath, newPath) : undefined,
    };
  });

const removeNodes = (nodes: FileNode[], path: string): FileNode[] =>
  nodes
    .filter((node) => node.path !== path && !node.path.startsWith(path + "/"))
    .map((node) => ({
      ...node,
      children: node.children ? removeNodes(node.children, path) : undefined,
    }));

const getDbtArgsStorageKey = (projectId: string, userId: string) => `dbt-command-args:${userId}:${projectId}`;
const getDbtFullRefreshStorageKey = (projectId: string, userId: string) => `dbt-full-refresh:${userId}:${projectId}`;
const getDbtTargetStorageKey = (projectId: string, userId: string) => `dbt-target:${userId}:${projectId}`;

const toEnvironmentPayload = (_vars: DbtEnvironmentVariable[]): Record<string, string> => ({});

const loadDbtCommandArgs = (projectId: string, userId: string): string => {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(getDbtArgsStorageKey(projectId, userId)) || "";
};

const loadDbtFullRefresh = (projectId: string, userId: string): boolean => {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(getDbtFullRefreshStorageKey(projectId, userId)) === "true";
};

const loadDbtTarget = (projectId: string, userId: string): string => {
  if (typeof window === "undefined") return DEFAULT_DBT_TARGET;
  return localStorage.getItem(getDbtTargetStorageKey(projectId, userId)) || DEFAULT_DBT_TARGET;
};

const clearLegacyBrowserStorage = (projectId: string): void => {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(`dbt-command-args:${projectId}`);
    localStorage.removeItem(`dbt-full-refresh:${projectId}`);
    localStorage.removeItem("dbt-session-id");
    localStorage.removeItem("git_credentials");
    sessionStorage.removeItem("git_credentials_session");
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("dbt-env-vars:")) localStorage.removeItem(key);
    }
    clearLegacyDevelopSession(projectId);
  } catch {
    // Ignore storage access failures.
  }
};

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 520;

export default function DevelopLayout({ projectId }: DevelopLayoutProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { setContent: setTopBarContent } = useTopBar();
  const restoredSession = useRef<Partial<DevelopSessionState>>({}).current;
  const restoredForUserRef = useRef<string | null>(null);
  const draftCounterRef = useRef(
    (restoredSession.openTabs ?? []).reduce((max, tab) => {
      const match = tab.name?.match(/^Untitled-(\d+)\.sql$/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0)
  );

  const [project, setProject] = useState<DbtProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(restoredSession.sidebarCollapsed ?? false);
  const [sidebarWidth, setSidebarWidth] = useState(restoredSession.sidebarWidth ?? 256);
  const restoredSidebarTab = restoredSession.sidebarTab === "git" || restoredSession.sidebarTab === "history"
    ? restoredSession.sidebarTab
    : "files";
  const [sidebarTab, setSidebarTab] = useState<SidebarTabType>(restoredSidebarTab);
  const sidebarPanelRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  const [searchQuery, setSearchQuery] = useState(restoredSession.searchQuery ?? "");
  const [selectedFile, setSelectedFile] = useState<string | null>(restoredSession.selectedFile ?? null);
  const [fileContent, setFileContent] = useState(restoredSession.fileContent ?? "");
  const [terminalOpen, setTerminalOpen] = useState(restoredSession.terminalOpen ?? false);
  const [terminalHeight, setTerminalHeight] = useState(restoredSession.terminalHeight ?? 250);
  const [terminalOutput, setTerminalOutput] = useState<string[]>(restoredSession.terminalOutput ?? []);
  const [terminalInput, setTerminalInput] = useState(restoredSession.terminalInput ?? "");
  const [terminalTab, setTerminalTab] = useState<TerminalTabType>(
    restoredSession.terminalTab === "queryPlan" ? "results" : restoredSession.terminalTab ?? "logs"
  );
  const agent = useAgentAvailability();
  const [agentOpen, setAgentOpen] = useState(false);
  const [queryPanelView, setQueryPanelView] = useState<QueryPanelView>(
    restoredSession.queryPanelView ?? (restoredSession.terminalTab === "queryPlan" ? "plan" : "results")
  );

  const [queryResults, setQueryResults] = useState<{
    data: Record<string, unknown>[];
    columns: string[];
    columnTypes?: Record<string, string>;
    rowCount?: number;
    executionTime?: number;
  }>(restoredSession.queryResults ?? { data: [], columns: [] });
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(restoredSession.queryError ?? null);
  const [compiledSQL, setCompiledSQL] = useState(restoredSession.compiledSQL ?? "");
  const [compiledLoading, setCompiledLoading] = useState(false);
  const [compiledError, setCompiledError] = useState<string | null>(restoredSession.compiledError ?? null);
  const [queryPlan, setQueryPlan] = useState<{
    adapter: string;
    model: string;
    mode: "Estimated";
    plan: string;
    signals: string[];
    executionTime?: number;
    compiledSql?: string;
  }>(restoredSession.queryPlan ?? { adapter: "", model: "", mode: "Estimated", plan: "", signals: [] });
  const [queryPlanLoading, setQueryPlanLoading] = useState(false);
  const [queryPlanLoadingStage, setQueryPlanLoadingStage] = useState<string | null>(null);
  const [queryPlanError, setQueryPlanError] = useState<string | null>(restoredSession.queryPlanError ?? null);

  const [lineageNodes, setLineageNodes] = useState<
    { id: string; name: string; type: string; schema?: string; position?: "upstream" | "current" | "downstream"; columns?: string[] }[]
  >(restoredSession.lineageNodes ?? []);
  const [lineageEdges, setLineageEdges] = useState<{ from: string; to: string }[]>(restoredSession.lineageEdges ?? []);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageError, setLineageError] = useState<string | null>(restoredSession.lineageError ?? null);
  const [columnLineage, setColumnLineage] = useState<
    Record<string, { column: string; table: string; expression?: string }[]>
  >(restoredSession.columnLineage ?? {});

  const [openTabs, setOpenTabs] = useState<OpenTab[]>(restoredSession.openTabs ?? []);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(restoredSession.activeTabPath ?? null);
  const [diffRequest, setDiffRequest] = useState<{ path: string; requestId: number } | null>(null);
  const [gitStatus, setGitStatus] = useState<{ clean: boolean; changes: { status: string; path: string }[] }>({
    clean: true,
    changes: [],
  });
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(restoredSession.expandedPaths ?? []));
  const [loadedChildren, setLoadedChildren] = useState<Record<string, FileNode[]>>(restoredSession.loadedChildren ?? {});
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const recentlySavedFilesRef = useRef<Set<string>>(new Set());
  const intellisenseRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [fileWatcherConnected, setFileWatcherConnected] = useState(false);
  const [createFileTrigger] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<ProjectSettingsTab>("general");
  // Bumped when the settings dialog adds or removes a target, so the toolbar
  // selector does not keep offering one that no longer exists.
  const [targetsVersion, setTargetsVersion] = useState(0);
  const worktreeLabel = project?.git_project_subdirectory?.trim() || "Repository root";
  const openSettings = useCallback((tab: ProjectSettingsTab = "general") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);
  const [dbtArgsDialogOpen, setDbtArgsDialogOpen] = useState(false);
  const [dbtCommandArgs, setDbtCommandArgs] = useState("");
  const [dbtFullRefresh, setDbtFullRefresh] = useState(false);
  // Which profiles.yml output every command in this project runs against.
  const [dbtTarget, setDbtTarget] = useState(DEFAULT_DBT_TARGET);
  const [environmentVariables, setEnvironmentVariables] = useState<DbtEnvironmentVariable[]>([]);
  const [envVarsSaving, setEnvVarsSaving] = useState(false);
  const [envVarsError, setEnvVarsError] = useState<string | null>(null);

  const [gitCredDialog, setGitCredDialog] = useState<{
    isOpen: boolean;
    pendingCommand: string;
    type: "push" | "pull";
    error?: string;
  }>({ isOpen: false, pendingCommand: "", type: "push" });
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [hardDeleteDialogOpen, setHardDeleteDialogOpen] = useState(false);
  const [operationLoading, setOperationLoading] = useState(false);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    const panel = sidebarPanelRef.current;

    if (!panel) return;

    let nextWidth = startWidth;
    let animationFrame: number | null = null;

    const applyWidth = () => {
      panel.style.width = `${nextWidth}px`;
      animationFrame = null;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + moveEvent.clientX - startX)
      );

      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(applyWidth);
      }
    };

    const handlePointerUp = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }

      panel.style.width = `${nextWidth}px`;
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, []);

  useEffect(() => {
    if (!project) {
      setTopBarContent(null);
      return;
    }

    const hasChanges = gitStatus.changes.length > 0;
    const projectStatus = project.deleted_at ? "Deleted" : hasChanges ? `${gitStatus.changes.length} changed` : "Clean";

    setTopBarContent(
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href="/develop"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#616161] transition-colors hover:bg-[#F3F2F1] hover:text-[#242424]"
          title="Back to projects"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger className="group flex min-w-0 max-w-[min(68vw,620px)] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[#F3F2F1] focus:outline-none focus:ring-2 focus:ring-[#0078D4]/20">
            <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md border-l-4 border-[#038387] bg-[#038387]/10 sm:flex">
              <Database className="h-4 w-4 text-[#038387]" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold leading-5 text-[#242424] sm:text-base">{project.name}</span>
                <span
                  className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline-flex ${
                    project.deleted_at
                      ? "bg-red-50 text-red-700"
                      : hasChanges
                      ? "bg-amber-50 text-amber-700"
                      : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {projectStatus}
                </span>
              </span>
              <span className="mt-0.5 hidden min-w-0 items-center gap-1.5 text-xs text-[#616161] sm:flex">
                <GitBranch className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{project.git_branch || "main"}</span>
                <span className="text-gray-300">/</span>
                <span className="truncate font-mono">{worktreeLabel}</span>
              </span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[#616161] transition-transform group-data-[state=open]:rotate-180" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[min(92vw,380px)] p-0">
            <DropdownMenuLabel className="border-b border-gray-100 px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border-l-4 border-[#038387] bg-[#038387]/10">
                  <Database className="h-4 w-4 text-[#038387]" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-950">{project.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs font-normal text-gray-500">
                    {project.description || "No description"}
                  </p>
                </div>
              </div>
            </DropdownMenuLabel>

            <div className="space-y-2 px-3 py-3 text-xs">
              <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2">
                <span className="text-gray-500">Branch</span>
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-gray-800">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="truncate">{project.git_branch || "main"}</span>
                </span>
              </div>
              <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2">
                <span className="text-gray-500">Worktree dir</span>
                <span className="truncate rounded bg-gray-50 px-1.5 py-0.5 font-mono text-gray-800" title={worktreeLabel}>
                  {worktreeLabel}
                </span>
              </div>
              {project.git_url && (
                <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2">
                  <span className="text-gray-500">Remote</span>
                  <span className="truncate font-mono text-gray-700" title={project.git_url}>
                    {project.git_url}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2">
                <span className="text-gray-500">Project ID</span>
                <span className="truncate font-mono text-gray-700" title={project.id}>
                  {project.id}
                </span>
              </div>
            </div>

            <DropdownMenuSeparator className="my-0" />
            {!project.deleted_at ? (
              <>
                <DropdownMenuItem
                  onClick={() => {
                    loadConnections();
                    openSettings("general");
                  }}
                  className="mx-1 my-1"
                >
                  <SlidersHorizontal className="mr-2 h-4 w-4" />
                  Project settings
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem
                  onClick={() => {
                    loadConnections();
                    openSettings("danger");
                  }}
                  className="mx-1 my-1"
                >
                  <SlidersHorizontal className="mr-2 h-4 w-4" />
                  Project settings
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          onClick={() => openSettings(project.deleted_at ? "danger" : "general")}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-[#616161] transition-colors hover:bg-[#F3F2F1] hover:text-[#242424] md:flex"
          title={project.deleted_at ? "Restore project" : "Rename project"}
        >
          {project.deleted_at ? <RotateCcw className="h-4 w-4" /> : <Edit className="h-4 w-4" />}
        </button>

        {!project.deleted_at && (
          <div className="hidden shrink-0 md:flex">
            <TargetSelector
              projectId={project.id}
              value={dbtTarget}
              onChange={setDbtTarget}
              onManage={() => openSettings("environments")}
              reloadKey={targetsVersion}
            />
          </div>
        )}
      </div>
    );

    return () => setTopBarContent(null);
  }, [dbtTarget, gitStatus.changes.length, gitStatus.clean, openSettings, project, setTopBarContent, targetsVersion, worktreeLabel]);

  useEffect(() => {
    if (!userId || restoredForUserRef.current === userId) return;
    restoredForUserRef.current = userId;
    clearLegacyBrowserStorage(projectId);

    const restored = loadDevelopSession(projectId, userId);
    setSidebarCollapsed(restored.sidebarCollapsed ?? false);
    setSidebarWidth(restored.sidebarWidth ?? 256);
    setSidebarTab(restored.sidebarTab === "git" || restored.sidebarTab === "history" ? restored.sidebarTab : "files");
    setSearchQuery(restored.searchQuery ?? "");
    setSelectedFile(restored.selectedFile ?? null);
    setFileContent(restored.fileContent ?? "");
    setTerminalOpen(restored.terminalOpen ?? false);
    setTerminalHeight(restored.terminalHeight ?? 250);
    setTerminalOutput(restored.terminalOutput ?? []);
    setTerminalInput(restored.terminalInput ?? "");
    setTerminalTab(restored.terminalTab === "queryPlan" ? "results" : restored.terminalTab ?? "logs");
    setQueryPanelView(restored.queryPanelView ?? (restored.terminalTab === "queryPlan" ? "plan" : "results"));
    setQueryResults(restored.queryResults ?? { data: [], columns: [] });
    setQueryError(restored.queryError ?? null);
    setCompiledSQL(restored.compiledSQL ?? "");
    setCompiledError(restored.compiledError ?? null);
    setQueryPlan(restored.queryPlan ?? { adapter: "", model: "", mode: "Estimated", plan: "", signals: [] });
    setQueryPlanError(restored.queryPlanError ?? null);
    setLineageNodes(restored.lineageNodes ?? []);
    setLineageEdges(restored.lineageEdges ?? []);
    setLineageError(restored.lineageError ?? null);
    setColumnLineage(restored.columnLineage ?? {});
    setOpenTabs(restored.openTabs ?? []);
    setActiveTabPath(restored.activeTabPath ?? null);
    setExpandedPaths(new Set(restored.expandedPaths ?? []));
    setLoadedChildren(restored.loadedChildren ?? {});
    setDbtCommandArgs(loadDbtCommandArgs(projectId, userId));
    setDbtFullRefresh(loadDbtFullRefresh(projectId, userId));
    setDbtTarget(loadDbtTarget(projectId, userId));

    void envVarsApi.list(projectId)
      .then((vars) => {
        setEnvironmentVariables(vars.map((item) => ({
          id: item.id,
          name: item.name,
          value: "",
          type: item.type,
          hasValue: item.hasValue,
        })));
        setEnvVarsError(null);
      })
      .catch((error) => setEnvVarsError(error instanceof Error ? error.message : "Failed to load env vars"));
  }, [projectId, userId]);

  useEffect(() => {
    if (typeof window === "undefined" || !userId) return;
    localStorage.setItem(getDbtArgsStorageKey(projectId, userId), dbtCommandArgs);
  }, [projectId, userId, dbtCommandArgs]);

  useEffect(() => {
    if (typeof window === "undefined" || !userId) return;
    localStorage.setItem(getDbtFullRefreshStorageKey(projectId, userId), String(dbtFullRefresh));
  }, [projectId, userId, dbtFullRefresh]);

  useEffect(() => {
    if (typeof window === "undefined" || !userId) return;
    localStorage.setItem(getDbtTargetStorageKey(projectId, userId), dbtTarget);
  }, [projectId, userId, dbtTarget]);

  useEffect(() => {
    if (!userId) return;
    saveDevelopSession(projectId, userId, {
      sidebarCollapsed,
      sidebarWidth,
      sidebarTab,
      searchQuery,
      selectedFile,
      fileContent,
      terminalOpen,
      terminalHeight,
      terminalOutput,
      terminalInput,
      terminalTab,
      queryPanelView,
      queryResults,
      queryError,
      compiledSQL,
      compiledError,
      queryPlan,
      queryPlanError,
      lineageNodes,
      lineageEdges,
      lineageError,
      columnLineage,
      openTabs,
      activeTabPath,
      expandedPaths: [...expandedPaths],
      loadedChildren,
    });
  }, [
    projectId,
    userId,
    sidebarCollapsed,
    sidebarWidth,
    sidebarTab,
    searchQuery,
    selectedFile,
    fileContent,
    terminalOpen,
    terminalHeight,
    terminalOutput,
    terminalInput,
    terminalTab,
    queryPanelView,
    queryResults,
    queryError,
    compiledSQL,
    compiledError,
    queryPlan,
    queryPlanError,
    lineageNodes,
    lineageEdges,
    lineageError,
    columnLineage,
    openTabs,
    activeTabPath,
    expandedPaths,
    loadedChildren,
  ]);

  const {
    metadata: dbtIntellisense,
    loading: intellisenseLoading,
    error: intellisenseError,
    refresh: refreshDbtIntellisense,
  } = useDbtIntellisense(projectId);

  const scheduleIntellisenseRefresh = useCallback((path?: string) => {
    if (path && !/\.(sql|ya?ml|md)$/i.test(path)) return;
    if (intellisenseRefreshTimerRef.current) {
      clearTimeout(intellisenseRefreshTimerRef.current);
    }
    intellisenseRefreshTimerRef.current = setTimeout(() => {
      void refreshDbtIntellisense();
    }, 500);
  }, [refreshDbtIntellisense]);

  const handleSaveEnvironmentVariables = async () => {
    setEnvVarsSaving(true);
    setEnvVarsError(null);
    try {
      const saved = await envVarsApi.replace(
        projectId,
        environmentVariables
          .map((item) => ({
            name: item.name.trim(),
            type: item.type,
            value: item.value || undefined,
            keepExisting: !item.value && item.hasValue === true,
          }))
          .filter((item) => item.name)
      );
      setEnvironmentVariables(saved.map((item) => ({
        id: item.id,
        name: item.name,
        value: "",
        type: item.type,
        hasValue: item.hasValue,
      })));
    } catch (error) {
      setEnvVarsError(error instanceof Error ? error.message : "Failed to save env vars");
    } finally {
      setEnvVarsSaving(false);
    }
  };

  // ---- SSE stream for dbt logs ----
  const activeDbtCommandRef = useRef<string | null>(null);
  const dbtRunStream = useDbtRunStream({
    projectId,
    onLogLine: (line) => setTerminalOutput((prev) => [...prev, line]),
    onCommandStart: (command) => {
      setTerminalOutput((prev) => [...prev, `$ ${command}`]);
      setIsCommandRunning(true);
    },
    onCommandComplete: (returncode) => {
      setIsCommandRunning(false);
      if (returncode === 0) {
        setTerminalOutput((prev) => [...prev, "[SUCCESS] Command completed successfully"]);
        const command = activeDbtCommandRef.current;
        if (command && /^(parse|compile|docs|build|run)\b/.test(command)) {
          void refreshDbtIntellisense();
        }
      } else {
        setTerminalOutput((prev) => [...prev, `[ERROR] Command failed with exit code ${returncode}`]);
      }
      activeDbtCommandRef.current = null;
    },
    onError: (error) => {
      setTerminalOutput((prev) => [...prev, `[ERROR] ${error}`]);
      setIsCommandRunning(false);
      activeDbtCommandRef.current = null;
    },
    autoConnect: false,
  });

  useEffect(() => {
    if (dbtRunStream.isConnected || dbtRunStream.isConnecting) {
      setIsCommandRunning(true);
    }
  }, [dbtRunStream.isConnected, dbtRunStream.isConnecting]);

  // ---- Load project + models ----
  useEffect(() => {
    loadProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (project) {
      loadFileTree();
      loadGitStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    return () => {
      if (intellisenseRefreshTimerRef.current) {
        clearTimeout(intellisenseRefreshTimerRef.current);
      }
    };
  }, []);

  // ---- File Watcher ----
  /**
   * Reload every already-expanded directory on the way to a changed path.
   *
   * The file endpoint returns one level, so refreshing the root alone leaves an
   * expanded folder showing the children it was loaded with - which is why a file
   * written into `models/marts` (by the assistant, by git, by anything outside
   * this tab) only appeared after collapsing and expanding it again.
   */
  const refreshAncestors = (path: string | undefined) => {
    if (!path) return;
    const parts = path.replace(/^\/+/, "").split("/");
    // Drop the entry itself; what changed is its parent's listing.
    parts.pop();
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (loadedChildren[prefix] !== undefined) void handleLoadChildren(prefix);
    }
  };

  const handleFileWatcherEvent = (event: FileWatcherEvent) => {
    switch (event.type) {
      case "created":
      case "deleted":
      case "moved":
        loadFileTree();
        refreshAncestors(event.path);
        loadGitStatus();
        scheduleIntellisenseRefresh(event.path);
        break;
      case "modified":
        if (event.path) {
          const eventPath = event.path.startsWith("/") ? event.path.substring(1) : event.path;
          if (recentlySavedFilesRef.current.has(eventPath)) {
            recentlySavedFilesRef.current.delete(eventPath);
            return;
          }
          const openTab = openTabs.find((t) => t.path === eventPath);
          if (openTab && !openTab.isDirty) {
            handleFileSelect(eventPath);
          }
        }
        loadGitStatus();
        scheduleIntellisenseRefresh(event.path);
        break;
    }
  };

  useFileWatcher(projectId, {
    onEvent: handleFileWatcherEvent,
    onConnect: () => setFileWatcherConnected(true),
    onDisconnect: () => setFileWatcherConnected(false),
    autoReconnect: true,
    reconnectDelay: 2000,
  });

  // ---- Data loading ----
  const buildFileTree = (items: Array<{ name: string; path: string; type: string }>): FileNode[] => {
    return items.map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type === "folder" ? "directory" : "file",
      children: item.type === "folder" ? [] : undefined,
    })) as FileNode[];
  };

  const loadFileTree = async () => {
    try {
      const data = await filesApi.list(projectId);
      const tree = buildFileTree(data.items || []);
      setFileTree(tree);
    } catch (error: unknown) {
      const apiError = error as { message?: string; status?: number };
      if (apiError.status === 404 && project?.git_url) {
        const shouldClone = window.confirm(
          "⚠️ Project files not found in workspace.\n\nDo you want to clone from Git?\n\nWARNING: This will overwrite any existing local changes!"
        );
        if (!shouldClone) {
          setTerminalOutput((prev) => [...prev, "❌ Clone cancelled by user."]);
          setTerminalOpen(true);
          setFileTree([]);
          return;
        }
        setTerminalOutput((prev) => [...prev, "📦 Cloning from git..."]);
        setTerminalOpen(true);
        try {
          const cloneResult = await gitApi.clone(
            projectId,
            project.git_url,
            project.git_branch || "main",
          );
          if (cloneResult.success) {
            setTerminalOutput((prev) => [...prev, `✅ ${cloneResult.message}`]);
            const retryData = await filesApi.list(projectId);
            setFileTree(buildFileTree(retryData.items || []));
            return;
          }
        } catch {
          setTerminalOutput((prev) => [...prev, "❌ Clone failed"]);
        }
      }
      setFileTree([]);
    }
  };

  const loadProject = async () => {
    try {
      const data = await getProjectById(projectId);
      setProject(data);
    } catch (error) {
      console.error("Error loading project:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadConnections = async () => {
    try {
      const res = await fetch("/api/connections");
      if (!res.ok) throw new Error("Failed to load connections");
      const data = await res.json();
      // /api/connections returns both unified connections (postgresql/duckdb/
      // dremio) and legacy dremio_sources, each tagged with connectionType and
      // _sourceTable. Keep all of them so any connection can be re-selected.
      const mapped = (data || []).map(
        (c: { id: string; name: string; connectionType: string; host?: string; port?: number; _sourceTable: "connection" | "dremio_source" }) => ({
          id: c.id,
          name: c.name,
          type: c.connectionType,
          host: c.host,
          port: c.port,
          is_active: true,
          sourceTable: c._sourceTable,
        })
      );
      setConnections(mapped);
    } catch (error) {
      console.error("Error loading connections:", error);
    }
  };

  const updateProjectConnection = async (connectionId: string) => {
    try {
      // Route the selected id to the right column: unified connections use
      // connection_id, legacy dremio_sources use dremio_source_id. Always
      // clear the other so a project never points at both.
      const conn = connectionId ? connections.find((c) => c.id === connectionId) : null;
      const patch =
        connectionId === ""
          ? { connectionId: null, dremioSourceId: null }
          : conn?.sourceTable === "dremio_source"
          ? { connectionId: null, dremioSourceId: connectionId }
          : { connectionId: connectionId, dremioSourceId: null };

      await updateProject(projectId, patch);
      if (project)
        setProject({
          ...project,
          connection_id: patch.connectionId,
          dremio_source_id: patch.dremioSourceId,
        });
      // Regenerate profiles.yml now so disk reflects the new connection
      // immediately. If it fails the next dbt run still regenerates it, so
      // don't block the UI on this.
      if (connectionId) {
        try {
          await dbtApi.regenerateProfiles(projectId);
        } catch (regenError) {
          console.error("Failed to regenerate profiles.yml:", regenError);
        }
      }
      setTerminalOutput((prev) => [...prev, connectionId ? "✅ Connection updated" : "✅ Connection disconnected"]);
    } catch (error) {
      console.error("Error updating connection:", error);
      alert("Failed to update connection");
    }
  };

  // ---- dbt commands ----
  const cancelCommand = async () => {
    try {
      const response = await fetch(`${getDbtRunnerUrl()}/process/cancel?project_id=${projectId}`, { method: "POST" });
      const data = await response.json();
      if (data.success) setTerminalOutput((prev) => [...prev, "^C", "⚠️ Command cancelled"]);
      setIsCommandRunning(false);
    } catch (err) {
      console.error("Failed to cancel command:", err);
    }
  };

  const handleRunDbt = async (command: string) => {
    const dbtEnvironment = toEnvironmentPayload(environmentVariables);
    const commandWithArgs = buildDbtCommandWithArgs(command, dbtCommandArgs, dbtFullRefresh, dbtTarget);
    setTerminalOpen(true);
    setTerminalTab("logs");
    setTerminalOutput((prev) => [...prev, "[INFO] Connecting to dbt-runner..."]);
    const connected = await dbtRunStream.connect();
    if (!connected) {
      setTerminalOutput((prev) => [...prev, "[WARN] Log stream unavailable, falling back to the HTTP API...", `$ dbt ${commandWithArgs}`, "Running..."]);
      setIsCommandRunning(true);
      try {
        const data = await dbtApi.runCommand(projectId, commandWithArgs, dbtEnvironment);
        if (data.success) {
          const lines = data.stdout.split("\n").filter((l: string) => l.trim());
          setTerminalOutput((prev) => [...prev, ...lines]);
          if (/^(parse|compile|docs|build|run)\b/.test(commandWithArgs)) {
            await refreshDbtIntellisense();
          }
        } else {
          if (data.stderr) setTerminalOutput((prev) => [...prev, "--- STDERR ---", ...data.stderr.split("\n").filter((l: string) => l.trim())]);
          if (data.stdout) setTerminalOutput((prev) => [...prev, "--- STDOUT ---", ...data.stdout.split("\n").filter((l: string) => l.trim())]);
        }
      } catch (err) {
        setTerminalOutput((prev) => [...prev, `Error: ${(err as Error).message || "Network error"}`]);
      } finally {
        setIsCommandRunning(false);
      }
      return;
    }
    activeDbtCommandRef.current = commandWithArgs;
    setTerminalOutput((prev) => [...prev, "[INFO] Connected via SSE"]);
    dbtRunStream.sendCommand(commandWithArgs, undefined, dbtEnvironment);
  };


  const handleRunParse = async () => {
    setTerminalOpen(true);
    setTerminalTab("logs");
    setTerminalOutput((prev) => [...prev, "$ dbt parse", "Parsing project metadata..."]);
    setIsCommandRunning(true);
    try {
      const data = await dbtApi.runCommand(projectId, "parse", toEnvironmentPayload(environmentVariables));
      if (data.success) {
        const lines = data.stdout.split("\n").filter((line: string) => line.trim());
        setTerminalOutput((prev) => [...prev, ...lines, "✅ Parse completed"]);
        await refreshDbtIntellisense();
      } else {
        const output = data.stderr || data.stdout || "Parse failed";
        setTerminalOutput((prev) => [...prev, `❌ ${output}`]);
      }
    } catch (err) {
      setTerminalOutput((prev) => [...prev, `❌ ${(err as Error).message}`]);
    } finally {
      setIsCommandRunning(false);
    }
  };

  const handlePreviewModel = async () => {
    const targetFile = await ensureSavedSqlFile();
    if (!targetFile || !targetFile.endsWith(".sql")) {
      setTerminalOutput((prev) => [...prev, "Please select a SQL model file to preview"]);
      return;
    }
    setTerminalOpen(true);
    setTerminalTab("results");
    setQueryPanelView("results");
    setQueryLoading(true);
    setQueryError(null);
    setIsCommandRunning(true);
    const extraArgs = buildDbtAdditionalArgs("show", dbtCommandArgs, dbtFullRefresh);
    const dbtEnvironment = toEnvironmentPayload(environmentVariables);
    setTerminalOutput((prev) => [...prev, `$ dbt show --select ${targetFile.split("/").pop()?.replace(".sql", "")}${extraArgs ? ` ${extraArgs}` : ""}`]);
    try {
      const data = await dbtApi.preview(projectId, targetFile, 100, extraArgs || undefined, dbtEnvironment);
      setQueryLoading(false);
      setIsCommandRunning(false);
      if (data.success) {
        setQueryResults({ data: data.data, columns: data.columns, columnTypes: data.column_types, rowCount: data.row_count, executionTime: data.execution_time });
        setTerminalOutput((prev) => [...prev, `✅ Preview completed: ${data.row_count} rows in ${data.execution_time?.toFixed(2)}s`]);
      } else {
        setQueryError(data.error || "Preview failed");
        setTerminalOutput((prev) => [...prev, `❌ ${data.error || "Preview failed"}`]);
      }
    } catch (err) {
      setQueryLoading(false);
      setIsCommandRunning(false);
      setQueryError((err as Error).message);
    }
  };

  const handleLoadLineage = async () => {
    if (!selectedFile || !selectedFile.endsWith(".sql")) {
      setLineageError("Please select a SQL model file to view lineage");
      return;
    }
    setLineageLoading(true);
    setLineageError(null);
    try {
      const data = await dbtApi.getLineage(projectId, selectedFile);
      setLineageLoading(false);
      if (data.success) {
        setLineageNodes(
          (data.table_lineage?.nodes || []).map((node) => ({
            ...node,
            position: node.position as "upstream" | "current" | "downstream" | undefined,
          }))
        );
        setLineageEdges(data.table_lineage?.edges || []);
        setColumnLineage(data.column_lineage || {});
      } else {
        setLineageError(data.error || "Failed to load lineage");
      }
    } catch (err) {
      setLineageLoading(false);
      setLineageError((err as Error).message);
    }
  };

  const handleCompileModel = async () => {
    const targetFile = await ensureSavedSqlFile();
    if (!targetFile || !targetFile.endsWith(".sql")) {
      setTerminalOutput((prev) => [...prev, "Please select a SQL model file to compile"]);
      return;
    }
    setTerminalOpen(true);
    setTerminalTab("compiled");
    setCompiledLoading(true);
    setCompiledError(null);
    const extraArgs = buildDbtAdditionalArgs("compile", dbtCommandArgs, dbtFullRefresh);
    const dbtEnvironment = toEnvironmentPayload(environmentVariables);
    setTerminalOutput((prev) => [...prev, `$ dbt compile --select ${targetFile.split("/").pop()?.replace(".sql", "")}${extraArgs ? ` ${extraArgs}` : ""}`]);
    try {
      const data = await dbtApi.compile(projectId, targetFile, extraArgs || undefined, dbtEnvironment);
      setCompiledLoading(false);
      if (data.success) {
        setCompiledSQL(data.compiled_sql);
        setTerminalOutput((prev) => [...prev, `✅ Compile completed`]);
        await refreshDbtIntellisense();
      } else {
        setCompiledError(data.error || "Compile failed");
        setTerminalOutput((prev) => [...prev, `❌ ${data.error || "Compile failed"}`]);
      }
    } catch (err) {
      setCompiledLoading(false);
      setCompiledError((err as Error).message);
    }
  };

  const handleExplainModel = async () => {
    const targetFile = await ensureSavedSqlFile();
    if (!targetFile || !targetFile.endsWith(".sql")) {
      setQueryPlanError("Please select a SQL model file to explain");
      setTerminalOpen(true);
      setTerminalTab("results");
      setQueryPanelView("plan");
      return;
    }

    setTerminalOpen(true);
    setTerminalTab("results");
    setQueryPanelView("plan");
    setQueryPlanLoading(true);
    setQueryPlanLoadingStage("Compiling model...");
    setQueryPlanError(null);
    setIsCommandRunning(true);

    const extraArgs = buildDbtAdditionalArgs("compile", dbtCommandArgs, dbtFullRefresh);
    const dbtEnvironment = toEnvironmentPayload(environmentVariables);
    let stageTimer: number | undefined;

    try {
      stageTimer = window.setTimeout(() => {
        setQueryPlanLoadingStage((stage) => (stage === "Compiling model..." ? "Running explain..." : stage));
      }, 500);
      const data = await dbtApi.explain(projectId, targetFile, extraArgs || undefined, dbtEnvironment);
      if (stageTimer !== undefined) window.clearTimeout(stageTimer);
      setQueryPlanLoading(false);
      setQueryPlanLoadingStage(null);
      setIsCommandRunning(false);

      if (data.success) {
        setQueryPlan({
          adapter: data.adapter,
          model: data.model,
          mode: data.mode,
          plan: data.plan,
          signals: data.signals,
          executionTime: data.execution_time,
          compiledSql: data.compiled_sql,
        });
        if (data.compiled_sql) {
          setCompiledSQL(data.compiled_sql);
          setCompiledError(null);
        }
      } else {
        setQueryPlan((prev) => ({
          ...prev,
          adapter: data.adapter || prev.adapter,
          model: data.model || targetFile.split("/").pop()?.replace(".sql", "") || prev.model,
          compiledSql: data.compiled_sql || prev.compiledSql,
        }));
        if (data.compiled_sql) setCompiledSQL(data.compiled_sql);
        setQueryPlanError(data.error || "Explain failed");
      }
    } catch (err) {
      if (stageTimer !== undefined) window.clearTimeout(stageTimer);
      setQueryPlanLoading(false);
      setQueryPlanLoadingStage(null);
      setIsCommandRunning(false);
      setQueryPlanError((err as Error).message);
    }
  };

  const handleRunCurrentModel = async () => {
    const targetFile = await ensureSavedSqlFile();
    if (!targetFile || !targetFile.endsWith(".sql")) {
      setTerminalOutput((prev) => [...prev, "Please select a SQL model file to run"]);
      return;
    }
    const modelName = targetFile.split("/").pop()?.replace(".sql", "") || "";
    await handleRunDbt(`run --select ${modelName}`);
  };


  // ---- File operations ----
  const handleFileSelect = async (path: string) => {
    setSelectedFile(path);
    setActiveTabPath(path);
    const existingTab = openTabs.find((t) => t.path === path);
    if (existingTab) {
      setFileContent(existingTab.content);
      return;
    }
    try {
      const data = await filesApi.read(projectId, path);
      const content = data.content || "";
      setFileContent(content);
      const fileName = path.split("/").pop() || path;
      setOpenTabs((prev) => [...prev, { path, name: fileName, content, originalContent: content, isDirty: false }]);
    } catch {
      setFileContent(`-- Cannot load file: ${path}`);
    }
  };

  const handleOpenDiff = async (path: string) => {
    await handleFileSelect(path);
    setDiffRequest({ path, requestId: Date.now() });
  };

  const handleTabChange = (path: string) => {
    setActiveTabPath(path);
    setSelectedFile(path);
    const tab = openTabs.find((t) => t.path === path);
    if (tab) setFileContent(tab.content);
  };

  const closeTab = (path: string) => {
    const tab = openTabs.find((t) => t.path === path);
    if (tab?.isDirty && !confirm("Unsaved changes. Close anyway?")) return;
    const newTabs = openTabs.filter((t) => t.path !== path);
    setOpenTabs(newTabs);
    if (activeTabPath === path) {
      if (newTabs.length > 0) {
        const lastTab = newTabs[newTabs.length - 1];
        setActiveTabPath(lastTab.path);
        setSelectedFile(lastTab.path);
        setFileContent(lastTab.content);
      } else {
        setActiveTabPath(null);
        setSelectedFile(null);
        setFileContent("");
      }
    }
  };

  const handleTabClose = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeTab(path);
  };

  // Monaco owns shortcuts while its editor has focus. The window listener
  // covers the rest of the IDE without firing the same command twice.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const modifierPressed = e.ctrlKey || e.metaKey;
      if (modifierPressed && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeTabPath) closeTab(activeTabPath);
        return;
      }
      if (modifierPressed && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createDraftSqlFile();
        return;
      }

      if (target.closest(".monaco-editor")) return;
      if (modifierPressed && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handlePreviewModel();
      } else if (modifierPressed && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        handleRunCurrentModel();
      } else if (modifierPressed && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveFile();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabPath, selectedFile, projectId, openTabs, fileContent]);

  const handleEditorChange = (value: string | undefined) => {
    const content = value || "";
    setFileContent(content);
    setOpenTabs((prev) =>
      prev.map((t) => (t.path === activeTabPath ? { ...t, content, isDirty: content !== t.originalContent } : t))
    );
  };

  /**
   * Format the active SQL file.
   *
   * The runner's formatter parses the SQL (sqlglot) instead of pattern-matching
   * keywords, so it is tried first; it refuses rather than guess when Jinja
   * control flow makes the statement unparseable, and then the local formatter
   * still tidies the file. Both the toolbar button and Shift+Alt+F land here.
   */
  const handleFormatSql = async () => {
    const path = activeTabPath || selectedFile;
    if (!path || !path.endsWith(".sql")) return;
    try {
      const result = await dbtApi.format(fileContent);
      if (result.formatted) {
        handleFormatContent(result.sql);
        return;
      }
      setTerminalOutput((prev) => [
        ...prev,
        `[INFO] Server formatter declined (${result.reason ?? "unknown reason"}); used the local formatter`,
      ]);
    } catch {
      // Runner unreachable - fall through to the local formatter silently.
    }
    handleFormatContent(formatFile(path, fileContent));
  };

  const handleFormatContent = (formatted: string) => {
    setFileContent(formatted);
    setOpenTabs((prev) =>
      prev.map((t) => (t.path === activeTabPath ? { ...t, content: formatted, isDirty: formatted !== t.originalContent } : t))
    );
  };

  const getFileLanguage = (path: string): string => {
    return path.split(".").pop()?.toLowerCase() || "";
  };

  const getActiveTab = () => openTabs.find((tab) => tab.path === activeTabPath) || null;

  const createDraftSqlFile = () => {
    draftCounterRef.current += 1;
    const name = `Untitled-${draftCounterRef.current}.sql`;
    const path = `__draft__/${Date.now()}-${draftCounterRef.current}.sql`;

    setOpenTabs((prev) => [
      ...prev,
      {
        path,
        name,
        content: "",
        originalContent: "",
        isDirty: false,
        isDraft: true,
      },
    ]);
    setActiveTabPath(path);
    setSelectedFile(path);
    setFileContent("");
  };

  const normalizeSavePath = (rawPath: string) => {
    const path = rawPath.trim().replace(/^\/+/, "");
    if (!path) return "";
    if (path.includes("/")) return path.endsWith(".sql") ? path : `${path}.sql`;
    return `models/${path.endsWith(".sql") ? path : `${path}.sql`}`;
  };

  const saveDraftAs = async (tab: OpenTab): Promise<string | null> => {
    const suggestedName = tab.name
      .replace(/\.sql$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const rawPath = window.prompt("Save SQL model as", `models/${suggestedName || "new_model"}.sql`);
    if (rawPath === null) return null;

    const path = normalizeSavePath(rawPath);
    if (!path) {
      alert("Please enter a file path.");
      return null;
    }

    await filesApi.save(projectId, path, fileContent);
    const fileName = path.split("/").pop() || path;
    setOpenTabs((prev) =>
      prev
        .filter((item) => item.path === tab.path || item.path !== path)
        .map((item) =>
          item.path === tab.path
            ? {
                ...item,
                path,
                name: fileName,
                content: fileContent,
                originalContent: fileContent,
                isDirty: false,
                isDraft: false,
              }
            : item
        )
    );
    setSelectedFile(path);
    setActiveTabPath(path);
    await loadFileTree();
    loadGitStatus();
    scheduleIntellisenseRefresh(path);
    return path;
  };

  const ensureSavedSqlFile = async (): Promise<string | null> => {
    const tab = getActiveTab();
    if (!tab) return null;
    if (tab.isDraft) return saveDraftAs(tab);
    if (tab.isDirty) {
      const saved = await handleSaveFile();
      if (!saved) return null;
    }
    return tab.path;
  };

  const getModelName = (): string => {
    const tab = getActiveTab();
    if (!tab && !selectedFile) return "*";
    const fileName = tab?.name || selectedFile?.split("/").pop() || "";
    return fileName.replace(".sql", "").replace(".yml", "").replace(".yaml", "");
  };

  const handleSaveFile = async (): Promise<boolean> => {
    const tab = getActiveTab();
    if (!tab || !selectedFile) return false;
    if (tab.isDraft) {
      setIsSaving(true);
      try {
        return !!(await saveDraftAs(tab));
      } catch {
        alert("❌ Cannot save draft");
        return false;
      } finally {
        setIsSaving(false);
      }
    }

    setIsSaving(true);
    try {
      recentlySavedFilesRef.current.add(selectedFile);
      const normalizedPath = selectedFile.startsWith("/") ? selectedFile.substring(1) : selectedFile;
      const slashedPath = selectedFile.startsWith("/") ? selectedFile : "/" + selectedFile;
      recentlySavedFilesRef.current.add(normalizedPath);
      recentlySavedFilesRef.current.add(slashedPath);
      setTimeout(() => {
        recentlySavedFilesRef.current.delete(selectedFile);
        recentlySavedFilesRef.current.delete(normalizedPath);
        recentlySavedFilesRef.current.delete(slashedPath);
      }, 3000);
      await filesApi.save(projectId, selectedFile, fileContent);
      setOpenTabs((prev) =>
        prev.map((t) => (t.path === selectedFile ? { ...t, content: fileContent, originalContent: fileContent, isDirty: false } : t))
      );
      loadGitStatus();
      scheduleIntellisenseRefresh(selectedFile);
      return true;
    } catch {
      recentlySavedFilesRef.current.delete(selectedFile);
      alert("❌ Cannot connect to dbt-runner");
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleSyncFromStorage = async () => {
    setIsRefreshing(true);
    try {
      setTerminalOutput((prev) => [...prev, "🔄 Syncing from storage..."]);
      const response = await fetch(`${getDbtRunnerUrl()}/project/sync/${projectId}`, { method: "POST" });
      if (response.ok) {
        const result = await response.json();
        if (result.synced) {
          setTerminalOutput((prev) => [...prev, "✅ Synced"]);
          await loadFileTree();
          if (activeTabPath) {
            const tab = openTabs.find((t) => t.path === activeTabPath);
            if (tab && !tab.isDirty) await handleFileSelect(activeTabPath);
          }
        }
      }
    } catch {
      setTerminalOutput((prev) => [...prev, "❌ Failed to sync"]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const refreshFolder = async (path: string) => {
    const data = await filesApi.list(projectId, path || undefined);
    const nodes = buildFileTree(data.items || []);
    if (path) {
      setLoadedChildren((prev) => ({ ...prev, [path]: nodes }));
    } else {
      setFileTree(nodes);
    }
  };

  const handleCreateFile = async (parentPath: string, name: string, type: "file" | "directory") => {
    if (!name.trim()) return;
    const path = parentPath ? `${parentPath}/${name}` : name;
    try {
      await filesApi.create(projectId, { path, file_type: type === "file" ? "file" : "directory", content: "" });
      const newNode: FileNode = {
        name,
        path,
        type,
        children: type === "directory" ? [] : undefined,
      };
      if (parentPath) {
        await refreshFolder(parentPath);
      } else {
        setFileTree((prev) => [...prev.filter((node) => node.path !== path), newNode]);
      }
      loadGitStatus();
      if (type === "file") handleFileSelect(path);
    } catch {
      alert("❌ Cannot connect to dbt-runner");
    }
  };

  const handleFilesUploaded = async (paths: string[]) => {
    setLoadedChildren({});
    await loadFileTree();
    loadGitStatus();
    if (paths[0]) {
      await handleFileSelect(paths[0]);
    }
  };

  const handleDeleteFile = async (path: string) => {
    if (!path?.trim() || !confirm(`Delete "${path}"?`)) return;
    try {
      await filesApi.delete(projectId, path);
      setFileTree((prev) => removeNodes(prev, path));
      setLoadedChildren((prev) =>
        Object.fromEntries(
          Object.entries(prev)
            .filter(([folderPath]) => folderPath !== path && !folderPath.startsWith(path + "/"))
            .map(([folderPath, nodes]) => [folderPath, removeNodes(nodes, path)])
        )
      );
      setExpandedPaths((prev) => new Set([...prev].filter((folderPath) => folderPath !== path && !folderPath.startsWith(path + "/"))));
      loadGitStatus();
      if (selectedFile === path) {
        setSelectedFile(null);
        setFileContent("");
      }
    } catch {
      alert("❌ Cannot connect to dbt-runner");
    }
  };

  const handleRenameFile = async (oldPath: string, newName: string) => {
    if (!newName.trim()) return;
    const parentPath = oldPath.split("/").slice(0, -1).join("/");
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
    try {
      await filesApi.rename(projectId, oldPath, newPath);
      setFileTree((prev) => renameNodes(prev, oldPath, newPath));
      setLoadedChildren((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([path, nodes]) => [
            renamePath(path, oldPath, newPath),
            renameNodes(nodes, oldPath, newPath),
          ])
        )
      );
      setExpandedPaths((prev) => new Set([...prev].map((path) => renamePath(path, oldPath, newPath))));
      setOpenTabs((prev) =>
        prev.map((t) => {
          if (t.path === oldPath) return { ...t, path: newPath, name: newName };
          if (t.path.startsWith(oldPath + "/")) return { ...t, path: t.path.replace(oldPath, newPath) };
          return t;
        })
      );
      if (selectedFile === oldPath) setSelectedFile(newPath);
      else if (selectedFile?.startsWith(oldPath + "/")) setSelectedFile(selectedFile.replace(oldPath, newPath));
      if (activeTabPath === oldPath) setActiveTabPath(newPath);
      else if (activeTabPath?.startsWith(oldPath + "/")) setActiveTabPath(activeTabPath.replace(oldPath, newPath));
      loadGitStatus();
    } catch {
      alert("❌ Cannot rename file");
    }
  };

  const handleMoveFile = async (sourcePath: string, destPath: string) => {
    try {
      const result = await filesApi.move(projectId, sourcePath, destPath);
      const actualDestPath = result.dest_path;
      setOpenTabs((prev) =>
        prev.map((t) => {
          if (t.path === sourcePath) return { ...t, path: actualDestPath, name: actualDestPath.split("/").pop() || "" };
          if (t.path.startsWith(sourcePath + "/")) return { ...t, path: t.path.replace(sourcePath, actualDestPath) };
          return t;
        })
      );
      if (selectedFile === sourcePath) setSelectedFile(actualDestPath);
      else if (selectedFile?.startsWith(sourcePath + "/")) setSelectedFile(selectedFile.replace(sourcePath, actualDestPath));
      setExpandedPaths((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          if (p === sourcePath) next.add(actualDestPath);
          else if (p.startsWith(sourcePath + "/")) next.add(p.replace(sourcePath, actualDestPath));
          else next.add(p);
        }
        return next;
      });
      setLoadedChildren((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([path, nodes]) => [
            renamePath(path, sourcePath, actualDestPath),
            renameNodes(nodes, sourcePath, actualDestPath),
          ])
        )
      );
      const sourceParent = sourcePath.split("/").slice(0, -1).join("/");
      const destParent = actualDestPath.split("/").slice(0, -1).join("/");
      await Promise.all([...new Set([sourceParent, destParent])].map(refreshFolder));
      loadGitStatus();
    } catch (error) {
      alert(`❌ ${error instanceof Error ? error.message : "Cannot move file"}`);
    }
  };

  // Delete several files/folders with a single confirmation.
  const handleDeleteFiles = async (paths: string[]) => {
    const targets = paths.filter((p) => p?.trim());
    if (targets.length === 0) return;
    const message = targets.length === 1 ? `Delete "${targets[0]}"?` : `Delete ${targets.length} items?`;
    if (!confirm(message)) return;

    let failed = 0;
    for (const path of targets) {
      try {
        await filesApi.delete(projectId, path);
      } catch {
        failed += 1;
      }
    }

    if (selectedFile && targets.some((p) => selectedFile === p || selectedFile.startsWith(p + "/"))) {
      setSelectedFile(null);
      setFileContent("");
    }
    setLoadedChildren({});
    await loadFileTree();
    loadGitStatus();
    if (failed > 0) alert(`❌ Failed to delete ${failed} item(s)`);
  };

  // Move several files/folders into the same destination folder.
  const handleMoveFiles = async (sourcePaths: string[], destPath: string) => {
    const sources = sourcePaths.filter(Boolean);
    if (sources.length === 0) return;

    let failed = 0;
    for (const source of sources) {
      try {
        await filesApi.move(projectId, source, destPath);
      } catch {
        failed += 1;
      }
    }

    setLoadedChildren({});
    await loadFileTree();
    loadGitStatus();
    if (failed > 0) alert(`❌ Failed to move ${failed} item(s)`);
  };

  // ---- Git operations ----
  const loadGitStatus = async () => {
    try {
      const data = await gitApi.getStatus(projectId);
      setGitStatus({ clean: data.clean, changes: data.changes || [] });
      const remotesData = await gitApi.getRemotes(projectId);
      if (remotesData.success && remotesData.remotes.length > 0) {
        const origin = remotesData.remotes.find((r) => r.name === "origin");
        if (origin) setGitRemoteUrl(origin.fetch_url);
      }
    } catch (error) {
      console.error("Error loading git status:", error);
    }
  };

  const handleGitCredentialSubmit = async (username: string, token: string, _rememberMe: boolean) => {
    const { pendingCommand, type } = gitCredDialog;
    setGitCredDialog({ isOpen: false, pendingCommand: "", type: "push" });
    setTerminalOpen(true);
    setTerminalTab("logs");
    setTerminalOutput((prev) => [...prev, `$ git ${pendingCommand}`, `Running git ${type}...`]);
    try {
      if (type === "push") {
        const data = await gitApi.push(projectId, username || undefined, token || undefined);
        if (data.success) { setTerminalOutput((prev) => [...prev, `✅ ${data.message}`]); loadGitStatus(); }
        else {
          if (data.stderr?.includes("Authentication") || data.stderr?.includes("403")) {
            setGitCredDialog({ isOpen: true, pendingCommand, type: "push", error: "Authentication failed" });
            return;
          }
          setTerminalOutput((prev) => [...prev, `❌ ${data.message}`, data.stderr || ""]);
        }
      } else {
        const parts = pendingCommand.split(" ");
        const branch = parts.length > 1 ? parts[parts.length - 1] : undefined;
        const data = await gitApi.pull(projectId, branch, username || undefined, token || undefined);
        if (data.success) { setTerminalOutput((prev) => [...prev, data.output || "", `✅ Completed`]); loadFileTree(); }
        else setTerminalOutput((prev) => [...prev, "❌ Pull failed"]);
      }
    } catch (e) { setTerminalOutput((prev) => [...prev, `❌ ${(e as Error).message}`]); }
  };

  const handleGitCredentialCancel = () => setGitCredDialog({ isOpen: false, pendingCommand: "", type: "push" });

  // ---- Docs ----
  const handleGenerateDocs = async () => {
    setDocsLoading(true);
    setTerminalOpen(true);
    setTerminalTab("logs");
    setTerminalOutput((prev) => [...prev, "$ dbt docs generate", "Generating documentation..."]);
    try {
      const result = await dbtApi.generateDocs(projectId);
      if (result.success) {
        const lines = result.stdout?.split("\n").filter((l: string) => l.trim()) || [];
        setTerminalOutput((prev) => [...prev, ...lines, "✅ Documentation generated"]);
        await refreshDbtIntellisense();
      } else setTerminalOutput((prev) => [...prev, `❌ ${result.message}`]);
    } catch (error) { setTerminalOutput((prev) => [...prev, `❌ ${(error as Error).message}`]); }
    finally { setDocsLoading(false); }
  };

  const handleOpenDocs = async () => {
    setDocsLoading(true);
    setTerminalOpen(true);
    setTerminalTab("logs");
    setTerminalOutput((prev) => [...prev, "$ dbt docs generate", "Generating..."]);
    const docsWindow = window.open("about:blank", "_blank");
    try {
      const result = await dbtApi.generateDocs(projectId);
      if (result.success) {
        setTerminalOutput((prev) => [...prev, "✅ Opening docs..."]);
        await refreshDbtIntellisense();
        if (docsWindow) {
          docsWindow.location.href = `/api/dbt-docs/view/${projectId}`;
        }
      } else {
        setTerminalOutput((prev) => [...prev, `❌ ${result.message}`]);
        if (docsWindow) docsWindow.close();
      }
    } catch (error) {
      setTerminalOutput((prev) => [...prev, `❌ ${(error as Error).message}`]);
      if (docsWindow) docsWindow.close();
    }
    finally { setDocsLoading(false); }
  };

  // ---- Project management ----
  const handleRenameProject = async (newName: string) => {
    if (!project) return;
    try { setOperationLoading(true); await updateProject(project.id, { name: newName }); setProject({ ...project, name: newName }); }
    catch { alert("Failed to rename"); }
    finally { setOperationLoading(false); }
  };

  const handleSoftDelete = async () => {
    if (!project) return;
    try {
      setOperationLoading(true);
      await fetch(`${getDbtRunnerUrl()}/project/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: project.id, hard_delete: false }) });
      await softDeleteProject(project.id);
      setDeleteDialogOpen(false);
      router.push("/develop");
    } catch { alert("Failed to delete"); }
    finally { setOperationLoading(false); }
  };

  const handleHardDelete = async () => {
    if (!project) return;
    try {
      setOperationLoading(true);
      await fetch(`${getDbtRunnerUrl()}/project/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: project.id, hard_delete: true }) });
      await hardDeleteProject(project.id);
      setHardDeleteDialogOpen(false);
      router.push("/develop");
    } catch { alert("Failed to permanently delete"); }
    finally { setOperationLoading(false); }
  };

  const handleRestoreProject = async () => {
    if (!project) return;
    try { setOperationLoading(true); await updateProject(project.id, { deletedAt: null } as Record<string, unknown>); setProject({ ...project, deleted_at: null }); setRestoreDialogOpen(false); }
    catch { alert("Failed to restore"); }
    finally { setOperationLoading(false); }
  };

  // ---- Terminal ----
  const handleTerminalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!terminalInput.trim()) return;
    const command = terminalInput.trim();
    setTerminalInput("");
    if (command.startsWith("dbt ")) { handleRunDbt(command.substring(4)); }
    else if (command.startsWith("git ")) {
      setTerminalOutput((prev) => [...prev, `$ ${command}`]);
      const gitCommand = command.substring(4);
      if (gitCommand.startsWith("push")) { setGitCredDialog({ isOpen: true, pendingCommand: gitCommand, type: "push" }); return; }
      else if (gitCommand.startsWith("pull")) { setGitCredDialog({ isOpen: true, pendingCommand: gitCommand, type: "pull" }); return; }
      try {
        const data = await gitApi.exec(projectId, gitCommand);
        if (data.stdout) setTerminalOutput((prev) => [...prev, ...data.stdout.split("\n").filter((l: string) => l)]);
        if (data.stderr) setTerminalOutput((prev) => [...prev, ...data.stderr.split("\n").filter((l: string) => l)]);
        if (gitCommand.includes("checkout") || gitCommand.includes("reset")) loadFileTree();
      } catch (error) { setTerminalOutput((prev) => [...prev, `❌ ${(error as Error).message}`]); }
    }
    else if (command === "clear") { setTerminalOutput([]); }
    else if (command === "help") {
      setTerminalOutput((prev) => [...prev, `$ ${command}`, "dbt <cmd>, git <cmd>, clear, help"]);
    }
    else { setTerminalOutput((prev) => [...prev, `$ ${command}`, `Unknown: ${command}. Type 'help'.`]); }
  };

  const handleClearTerminalTab = () => {
    if (terminalTab === "logs") setTerminalOutput([]);
    if (terminalTab === "results" && queryPanelView === "results") setQueryResults({ data: [], columns: [] });
    if (terminalTab === "results" && queryPanelView === "plan") {
      setQueryPlan({ adapter: "", model: "", mode: "Estimated", plan: "", signals: [] });
      setQueryPlanError(null);
    }
    if (terminalTab === "compiled") setCompiledSQL("");
    if (terminalTab === "queryPlan") {
      setQueryPlan({ adapter: "", model: "", mode: "Estimated", plan: "", signals: [] });
      setQueryPlanError(null);
    }
  };

  const handleLoadChildren = async (path: string): Promise<FileNode[]> => {
    try {
      const data = await filesApi.list(projectId, path);
      const children = buildFileTree(data.items || []);
      setLoadedChildren((prev) => ({ ...prev, [path]: children }));
      return children;
    } catch { return []; }
  };

  const handleToggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // ---- Render ----
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#0078D4]" />
      </div>
    );
  }

  if (!project) {
    return <div className="flex items-center justify-center h-full text-red-500">Project not found</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Main Area */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar Icons */}
        <div className="w-12 bg-gray-100 border-r border-gray-200 flex flex-col items-center py-2 gap-1">
          <button
            onClick={() => { setSidebarCollapsed(false); setSidebarTab("files"); }}
            className={`p-2 rounded ${sidebarTab === "files" && !sidebarCollapsed ? "bg-white text-[#0078D4] shadow-sm" : "text-gray-500 hover:text-[#0078D4] hover:bg-white"}`}
            title="Files"
          >
            <FolderTree className="h-5 w-5" />
          </button>
          <button
            onClick={() => { setSidebarCollapsed(false); setSidebarTab("git"); }}
            className={`p-2 rounded ${sidebarTab === "git" && !sidebarCollapsed ? "bg-white text-[#0078D4] shadow-sm" : "text-gray-500 hover:text-[#0078D4] hover:bg-white"}`}
            title="Git"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21.62 11.11l-8.73-8.73a1.3 1.3 0 0 0-1.78 0L8.79 4.7l2.25 2.25a1.54 1.54 0 0 1 1.94 1.95l2.17 2.17a1.54 1.54 0 1 1-.92.86l-2.03-2.03v5.34a1.55 1.55 0 1 1-1.27-.05V9.75a1.55 1.55 0 0 1-.84-2.03L7.84 5.47l-5.46 5.46a1.3 1.3 0 0 0 0 1.78l8.73 8.73a1.3 1.3 0 0 0 1.78 0l8.73-8.73a1.3 1.3 0 0 0 0-1.6z" />
            </svg>
          </button>
          <button
            onClick={() => { setSidebarCollapsed(false); setSidebarTab("history"); }}
            className={`p-2 rounded ${sidebarTab === "history" && !sidebarCollapsed ? "bg-white text-[#0078D4] shadow-sm" : "text-gray-500 hover:text-[#0078D4] hover:bg-white"}`}
            title="History"
          >
            <History className="h-5 w-5" />
          </button>
          <button
            onClick={() => openSettings("variables")}
            className="p-2 rounded text-gray-500 hover:text-[#0078D4] hover:bg-white"
            title="dbt Environment Variables"
          >
            <KeyRound className="h-5 w-5" />
          </button>
        </div>

        {/* Sidebar Panel */}
        <div
          ref={sidebarPanelRef}
          className={`${sidebarCollapsed ? "w-0 overflow-hidden" : ""} relative bg-white border-r border-gray-200 flex flex-col`}
          style={sidebarCollapsed ? undefined : { width: sidebarWidth }}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {sidebarTab === "files" && (
              <FileExplorer
                projectId={projectId}
                fileTree={fileTree}
                expandedPaths={expandedPaths}
                loadedChildren={loadedChildren}
                selectedFile={selectedFile}
                searchQuery={searchQuery}
                gitChanges={gitStatus.changes}
                onSearchChange={setSearchQuery}
                onFileSelect={handleFileSelect}
                onToggleExpand={handleToggleExpand}
                onLoadChildren={handleLoadChildren}
                onCreateFile={handleCreateFile}
                onDeleteFile={handleDeleteFile}
                onRenameFile={handleRenameFile}
                onMoveFile={handleMoveFile}
                onMoveFiles={handleMoveFiles}
                onDeleteFiles={handleDeleteFiles}
                onFilesUploaded={handleFilesUploaded}
                onRefresh={handleSyncFromStorage}
                isRefreshing={isRefreshing}
                fileWatcherConnected={fileWatcherConnected}
                createFileTrigger={createFileTrigger}
              />
            )}
            {sidebarTab === "git" && (
              <SourceControlPanel
                projectId={projectId}
                onRefresh={() => { loadFileTree(); loadGitStatus(); }}
                onOpenDiff={handleOpenDiff}
              />
            )}
            {sidebarTab === "history" && <CommitHistory projectId={projectId} />}
          </div>
          {!sidebarCollapsed && (
            <div
              className="absolute right-[-3px] top-0 z-20 h-full w-1.5 cursor-col-resize touch-none bg-transparent hover:bg-[#0078D4]/40"
              onPointerDown={startSidebarResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
            />
          )}
        </div>

        {/* Editor Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <EditorTabs
            projectId={projectId}
            tabs={openTabs}
            activeTabPath={activeTabPath}
            selectedFile={selectedFile}
            fileContent={fileContent}
            onTabChange={handleTabChange}
            onTabClose={handleTabClose}
            onContentChange={handleEditorChange}
            onSave={handleSaveFile}
            onPreview={handlePreviewModel}
            onExplain={handleExplainModel}
            onCompile={handleCompileModel}
            onRun={handleRunCurrentModel}
            onCloseCurrentTab={() => {
              if (activeTabPath) closeTab(activeTabPath);
            }}
            onOpenDbtArgs={() => setDbtArgsDialogOpen(true)}
            onNewDraft={createDraftSqlFile}
            onRunParse={handleRunParse}
            onOpenDefinition={handleFileSelect}
            onFormatSql={handleFormatSql}
            onFormatContent={handleFormatContent}
            getLanguage={getFileLanguage}
            isSaving={isSaving}
            dbtCommandArgs={dbtCommandArgs}
            dbtFullRefresh={dbtFullRefresh}
            dbtIntellisense={dbtIntellisense}
            intellisenseLoading={intellisenseLoading}
            intellisenseError={intellisenseError}
            diffRequest={diffRequest}
          />

          {/* Terminal Panel */}
          <TerminalPanel
            isOpen={terminalOpen}
            height={terminalHeight}
            currentTab={terminalTab}
            terminalOutput={terminalOutput}
            terminalInput={terminalInput}
            isCommandRunning={isCommandRunning}
            queryResults={queryResults}
            queryPanelView={queryPanelView}
            queryLoading={queryLoading}
            queryError={queryError}
            compiledSQL={compiledSQL}
            compiledLoading={compiledLoading}
            compiledError={compiledError}
            lineageNodes={lineageNodes}
            lineageEdges={lineageEdges}
            columnLineage={columnLineage}
            lineageLoading={lineageLoading}
            lineageError={lineageError}
            selectedFile={selectedFile}
            queryPlan={queryPlan}
            queryPlanLoading={queryPlanLoading}
            queryPlanLoadingStage={queryPlanLoadingStage}
            queryPlanError={queryPlanError}
            onTabChange={setTerminalTab}
            onQueryPanelViewChange={setQueryPanelView}
            onClose={() => setTerminalOpen(false)}
            onHeightChange={setTerminalHeight}
            onLoadLineage={handleLoadLineage}
            onRefreshQueryPlan={handleExplainModel}
            onClearTab={handleClearTerminalTab}
            onTerminalInputChange={setTerminalInput}
            onTerminalSubmit={handleTerminalSubmit}
            onCancelCommand={cancelCommand}
          />
        </div>

        {/* The dbt assistant, opened from the rail on the right. */}
        {agentOpen && agent.available && (
          <AgentPanel
            projectId={project.id}
            health={agent.health}
            userKeySet={agent.userKeySet}
            activeFilePath={activeTabPath}
            onOpenFile={handleFileSelect}
            onClose={() => setAgentOpen(false)}
          />
        )}

        {/* Right-side quick actions */}
        <RightPanel
          terminalOpen={terminalOpen}
          docsLoading={docsLoading}
          projectConnectionId={project?.connection_id || project?.dremio_source_id || null}
          connections={connections}
          isDirty={openTabs.find((tab) => tab.path === activeTabPath)?.isDirty || false}
          getModelName={getModelName}
          onRunDbt={handleRunDbt}
          onGenerateDocs={handleGenerateDocs}
          onOpenDocs={handleOpenDocs}
          onSaveFile={handleSaveFile}
          onToggleTerminal={() => setTerminalOpen((open) => !open)}
          onOpenSettings={() => {
            loadConnections();
            openSettings("general");
          }}
          onOpenDangerZone={() => {
            loadConnections();
            openSettings("danger");
          }}
          deleteProjectLabel={project.deleted_at ? "Delete Permanently" : "Delete Project"}
          onToggleAssistant={agent.available ? () => setAgentOpen((open) => !open) : undefined}
          assistantOpen={agentOpen}
        />
      </div>

      {dbtArgsDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-xl rounded-lg bg-white shadow-xl">
            <div className="border-b border-gray-200 px-5 py-4">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-5 w-5 text-[#0078D4]" />
                <h2 className="text-base font-semibold text-gray-900">dbt Command Arguments</h2>
              </div>
            </div>

            <div className="px-5 py-4">
              <label className="text-sm font-medium text-gray-700" htmlFor="dbt-command-args">
                Extra arguments for Preview, Run, and Compile
              </label>
              <Input
                id="dbt-command-args"
                value={dbtCommandArgs}
                onChange={(event) => setDbtCommandArgs(event.target.value)}
                className="mt-2"
                placeholder={`--full-refresh --vars '{"key":"value"}'`}
              />
              <p className="mt-2 text-xs text-gray-500">
                These arguments are appended to dbt show, dbt run, and dbt compile commands for this project.
              </p>

              <label className="mt-4 flex items-start gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-3">
                <input
                  type="checkbox"
                  checked={dbtFullRefresh}
                  onChange={(event) => setDbtFullRefresh(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[#0078D4] focus:ring-[#0078D4]"
                />
                <span>
                  <span className="block text-sm font-medium text-gray-800">Full refresh</span>
                  <span className="mt-1 block text-xs text-gray-500">
                    Appends --full-refresh to Preview, Run, Build, and Compile even if the extra args field is empty.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex justify-between gap-2 border-t border-gray-200 px-5 py-4">
              <Button variant="outline" onClick={() => { setDbtCommandArgs(""); setDbtFullRefresh(false); }}>Clear</Button>
              <Button onClick={() => setDbtArgsDialogOpen(false)}>Done</Button>
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <GitCredentialDialog
        isOpen={gitCredDialog.isOpen}
        operationType={gitCredDialog.type}
        remoteUrl={gitRemoteUrl}
        error={gitCredDialog.error}
        onSubmit={handleGitCredentialSubmit}
        onCancel={handleGitCredentialCancel}
      />

      <ProjectSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsTab}
        project={project}
        worktreeLabel={worktreeLabel}
        connections={connections}
        busy={operationLoading}
        onSelectConnection={updateProjectConnection}
        onRename={handleRenameProject}
        onTargetsChanged={() => setTargetsVersion((version) => version + 1)}
        environmentVariables={environmentVariables}
        onEnvironmentVariablesChange={setEnvironmentVariables}
        onSaveEnvironmentVariables={handleSaveEnvironmentVariables}
        envVarsSaving={envVarsSaving}
        envVarsError={envVarsError}
        onDeleteProject={() => setDeleteDialogOpen(true)}
        onRestoreProject={() => setRestoreDialogOpen(true)}
        onHardDeleteProject={() => setHardDeleteDialogOpen(true)}
      />
      <DeleteProjectDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        projectName={project?.name || ""}
        onSoftDelete={handleSoftDelete}
        onHardDelete={handleHardDelete}
        loading={operationLoading}
      />
      <RestoreProjectDialog
        open={restoreDialogOpen}
        onOpenChange={setRestoreDialogOpen}
        projectName={project?.name || ""}
        onConfirm={handleRestoreProject}
        loading={operationLoading}
      />
      <HardDeleteProjectDialog
        open={hardDeleteDialogOpen}
        onOpenChange={setHardDeleteDialogOpen}
        projectName={project?.name || ""}
        onConfirm={handleHardDelete}
        loading={operationLoading}
      />
    </div>
  );
}
