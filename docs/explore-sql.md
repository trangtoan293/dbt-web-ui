# Explore SQL workspace

Explore opens in SQL mode. Select a project at the top, then use the Data browser
beside the editor to search models, sources and columns. Expand an entry to see
its description, dbt file path, column names and available types. Click a column
to see its description; its plus button inserts it at the editor cursor.

Project selection and SQL/Docs/Dashboards share one compact toolbar. Docs refresh,
generation and opening in a new tab are available in the **Docs actions** (ellipsis)
menu; the missing-docs state also offers Generate Docs directly. Query tabs scroll
horizontally, with close buttons and a menu for renaming / closing other tabs.
Run, Save, Format, limit and execution environment share a wrapping toolbar.
Explore no longer repeats the global page title/project title or links to Develop.

**Insert reference** inserts a dbt `ref(package, model)` or `source(source, table)`.
Model names are not presented as physical warehouse relation names. Column
insertion uses `adapter.quote()` so quoting follows the project's adapter.
**Query this table** opens a new SELECT draft without executing SQL or replacing
the current draft. Choose the execution target and row limit, then Run. Results
appear below the editor with a draggable, keyboard-accessible separator. Choosing
Chart expands results; Restore SQL editor brings back the split layout and data
browser. On narrow screens, use the Data browser toggle.

Run on shows profile target, adapter, database and schema where available. Only
projects with multiple targets display a selector. Missing profile information is
explicitly labelled unverified/not resolved, not presented as a known connection.

## Metadata and completion

The browser and project completion provider share `/dbt/intellisense/{projectId}`
metadata from manifest/catalog artifacts. This is **not** a live warehouse inventory
or a schema refresh for the selected execution target. Missing types are shown as
`Type unavailable`; run dbt docs generate and reload metadata to enrich them.
The manifest timestamp is shown when provided by the API. Reload only reads existing
artifacts; it does not run dbt commands or query the warehouse.

Completion suggests dbt references after FROM/JOIN and columns for recognized
relations/aliases (including references later in the query). Each Monaco provider
is scoped to its own editor model and disposed on unmount. This is a conservative
helper for simple relations and dbt ref/source expressions, not a full SQL parser:
CTEs, nested alias scopes and arbitrary physical table names are not resolved.

## Drafts

Drafts and the active draft are stored per project in this browser's localStorage
under `explore-drafts:<projectId>`. The previous `explore-sql:<projectId>` draft is
migrated on first use without deleting the old value. Switching projects remounts
the console; stale metadata/query responses cannot populate the new workspace.
Switching draft or target clears previous results. Unsaved drafts are browser-only.
Save query writes `analyses/explore/<name>.sql` in the project. Saved queries can
be reopened from the folder button. Closing a dirty tab offers Save and close,
Discard changes, or Cancel; it never deletes the saved file. Deletion is a separate,
confirmed action. Saved files are project files, not automatically Git-committed.

Dashboards have a separate YAML workspace; see [dbt-charts.md](dbt-charts.md).

## Verification

Run `npm run test:unit` in `nextjs`. `test/explore-data.unit.test.ts` covers dbt
references, adapter quoting, relation/alias completion, comments, joins, missing
metadata, draft restoration and migration. Build with `docker compose build frontend`.
Browser checks use fixture projects, metadata and query responses; no warehouse
data is created or changed.

`nextjs/scripts/check-explore.cjs` exercises metadata search, types, insertion,
new drafts, project switching, browser reload, actual Monaco completion acceptance,
metadata error/retry and a 390px mobile viewport. It requires a local app using
the repository `.env` AUTH_SECRET, Playwright Core and a Chromium browser:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
CHROME_PATH=/absolute/path/to/chrome \
EXPLORE_TEST_URL=http://127.0.0.1:3000 node nextjs/scripts/check-explore.cjs
```

The script creates an isolated browser session, stubs application API responses,
and closes the session on completion. Screenshots are written to `/tmp/explore-data-*`.

Run `nextjs/scripts/check-workspace-density.cjs` with the same environment variables
to verify Explore and Orchestrate toolbar density. It checks SQL/Docs/table start
positions at 1440×900, Docs menu actions, Catalog, run filters, schedule dialog and
390px layouts. All writes are intercepted as fixtures. Orchestrate uses compact
inline run metrics, shared tabs/actions and full-width schedule lists; page padding
changes are scoped to Explore and Orchestrate only.
