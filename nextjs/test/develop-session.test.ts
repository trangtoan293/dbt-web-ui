import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDevelopSessionStorageKey,
  loadDevelopSession,
  saveDevelopSession,
  type DevelopSessionState,
} from "../src/lib/develop-session";

const createSessionStorage = () => {
  const values = new Map<string, string>();

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
};

const createSession = (content: string): DevelopSessionState => ({
  sidebarCollapsed: false,
  sidebarWidth: 256,
  sidebarTab: "files",
  searchQuery: "",
  selectedFile: "models/orders.sql",
  fileContent: content,
  terminalOpen: true,
  terminalHeight: 250,
  terminalOutput: ["$ dbt run --select orders", "Running..."],
  terminalInput: "",
  terminalTab: "logs",
  queryResults: { data: [], columns: [] },
  queryError: null,
  compiledSQL: "",
  compiledError: null,
  lineageNodes: [],
  lineageEdges: [],
  lineageError: null,
  columnLineage: {},
  openTabs: [{
    path: "models/orders.sql",
    name: "orders.sql",
    content,
    originalContent: "select 1",
    isDirty: true,
  }],
  activeTabPath: "models/orders.sql",
  expandedPaths: ["models"],
  loadedChildren: {},
});

describe("develop session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores unsaved SQL and terminal output for the same project", () => {
    vi.stubGlobal("window", { sessionStorage: createSessionStorage() });
    const session = createSession("select * from orders");

    saveDevelopSession("project-a", "user-a", session);

    expect(loadDevelopSession("project-a", "user-a")).toEqual(session);
  });

  it("keeps sessions isolated by project and user", () => {
    vi.stubGlobal("window", { sessionStorage: createSessionStorage() });

    saveDevelopSession("project-a", "user-a", createSession("select 1"));

    expect(loadDevelopSession("project-b", "user-a")).toEqual({});
    expect(loadDevelopSession("project-a", "user-b")).toEqual({});
    expect(getDevelopSessionStorageKey("project-a", "user-a")).not.toEqual(
      getDevelopSessionStorageKey("project-b", "user-a")
    );
    expect(getDevelopSessionStorageKey("project-a", "user-a")).not.toEqual(
      getDevelopSessionStorageKey("project-a", "user-b")
    );
  });
});
