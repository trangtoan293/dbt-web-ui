/**
 * What the assistant is told before an Explore prompt.
 *
 * The persona in dsh-agent's profile is fixed at spawn and describes the IDE:
 * edit models, run dbt. Explore is the other half of the job - read what dbt
 * already built, and turn it into a dashboard - so the difference is carried
 * per prompt instead of by a second agent service.
 *
 * It also names what is on screen, which is the answer to most of the
 * follow-up questions ("this query", "the dashboard I have open").
 */

export interface ExploreWorkspaceState {
  /** The open SQL tab's name and its text, when the SQL console is showing. */
  queryName?: string
  sql?: string
  /** The dashboard file open in the workspace, when one is saved. */
  dashboardPath?: string
  /** The dbt target the user picked, when it is not the project default. */
  target?: string
}

export interface ExploreAgentState extends ExploreWorkspaceState {
  /** Which Explore section is in front of the user. */
  view: "docs" | "sql" | "dashboards"
}

const BRIEF = [
  "You are in Explore, where the user reads data dbt has already built and turns it into dashboards.",
  "Answer with a query result rather than a description of one, and show the SQL you ran.",
  "- Definitions come from this project: mcp__dbt__list_models first, then the model's own .sql and its schema.yml. Never invent a column name.",
  "- Read-only SELECTs go through mcp__dbt__query. Do not run dbt here unless the user asks for a rebuild.",
  "- A dashboard is a YAML board file under charts/. mcp__dbt__charts_reference is the syntax and the samples, mcp__dbt__validate_dashboard checks a board before you save it, and saving it publishes it - the user opens the file and sees it rendered.",
  "- Reusable SQL belongs in analyses/explore/<name>.sql, which is what Saved queries lists.",
  "- Save the file, then name it: the panel can open a file you touched.",
].join("\n")

const SQL_LIMIT = 2000

/** The brief plus whatever the user is looking at right now. */
export function exploreAgentContext(state: ExploreAgentState): string {
  const lines = [BRIEF, ""]
  if (state.view === "sql") {
    lines.push(`Open now: the SQL console, tab "${state.queryName || "untitled"}".`)
    const sql = (state.sql ?? "").trim()
    // A long scratchpad is the user's working state, not the question; send
    // enough to see what they mean by "this query".
    if (sql) lines.push("Its SQL:", "```sql", sql.slice(0, SQL_LIMIT), "```")
  } else if (state.view === "dashboards") {
    lines.push(
      state.dashboardPath
        ? `Open now: the dashboard workspace, editing ${state.dashboardPath}. Read that file before changing it.`
        : "Open now: the dashboard workspace, on an unsaved board."
    )
  } else {
    lines.push("Open now: the generated dbt docs.")
  }
  if (state.target) lines.push(`Queries the user runs here use the "${state.target}" target.`)
  return lines.join("\n")
}

/** Where an agent-written file belongs in Explore, or null if it has no home here. */
export function exploreFileView(path: string): "sql" | "dashboards" | null {
  if (/\.sql$/i.test(path)) return "sql"
  if (/\.ya?ml$/i.test(path)) return "dashboards"
  return null
}
