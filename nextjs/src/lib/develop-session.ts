const STORAGE_PREFIX = "dbt-craft:develop-session:";

export interface DevelopSessionState {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  sidebarTab: "files" | "git" | "history";
  searchQuery: string;
  selectedFile: string | null;
  fileContent: string;
  terminalOpen: boolean;
  terminalHeight: number;
  terminalOutput: string[];
  terminalInput: string;
  terminalTab: "results" | "lineage" | "compiled" | "queryPlan" | "logs";
  queryPanelView?: "results" | "plan";
  queryResults: {
    data: Record<string, unknown>[];
    columns: string[];
    columnTypes?: Record<string, string>;
    rowCount?: number;
    executionTime?: number;
  };
  queryError: string | null;
  compiledSQL: string;
  compiledError: string | null;
  queryPlan?: {
    adapter: string;
    model: string;
    mode: "Estimated";
    plan: string;
    signals: string[];
    executionTime?: number;
    compiledSql?: string;
  };
  queryPlanError?: string | null;
  lineageNodes: {
    id: string;
    name: string;
    type: string;
    schema?: string;
    position?: "upstream" | "current" | "downstream";
    columns?: string[];
  }[];
  lineageEdges: { from: string; to: string }[];
  lineageError: string | null;
  columnLineage: Record<string, { column: string; table: string; expression?: string }[]>;
  openTabs: {
    path: string;
    name: string;
    content: string;
    originalContent: string;
    isDirty: boolean;
    isDraft?: boolean;
  }[];
  activeTabPath: string | null;
  expandedPaths: string[];
  loadedChildren: Record<string, DevelopFileNode[]>;
}

interface DevelopFileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: DevelopFileNode[];
}

export const getDevelopSessionStorageKey = (projectId: string, userId?: string | null) =>
  `${STORAGE_PREFIX}${userId || "anonymous"}:${projectId}`;

export function clearLegacyDevelopSession(projectId?: string): void {
  if (typeof window === "undefined") return;

  try {
    if (projectId) window.sessionStorage.removeItem(`${STORAGE_PREFIX}${projectId}`);
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) && !key.slice(STORAGE_PREFIX.length).includes(":")) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore storage access failures.
  }
}

export function loadDevelopSession(projectId: string, userId?: string | null): Partial<DevelopSessionState> {
  if (typeof window === "undefined") return {};

  try {
    const value = window.sessionStorage.getItem(getDevelopSessionStorageKey(projectId, userId));
    return value ? JSON.parse(value) as Partial<DevelopSessionState> : {};
  } catch {
    return {};
  }
}

export function saveDevelopSession(projectId: string, userId: string | null | undefined, state: DevelopSessionState): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(getDevelopSessionStorageKey(projectId, userId), JSON.stringify(state));
  } catch {
    // Keep the IDE usable if storage is disabled or the browser quota is full.
  }
}
