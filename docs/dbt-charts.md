# Query visualization with dbt-charts

Explore → SQL and Develop → model preview share the same result viewer. After a
query returns rows, select **Chart**, choose a chart type and fields, and click
**Build chart**. Bar, line, area, scatter, pie, donut, KPI and styled tables are
rendered by dbt Labs' actual `dbt-charts==0.8.0` package. Five built-in themes
are available. The normal Table view and CSV export remain available.

Charts use the returned query snapshot, not the entire source table. Aggregate
in SQL first; KPI requires exactly one row. The renderer accepts at
most 1,000 rows, 80 columns and a 2 MB request. Null values remain null. Numeric
text in the selected measure is converted to numbers; identifiers are preserved.

Download **HTML** for a self-contained rendered snapshot, or **Board YAML** for
the dbt-charts definition with inline data. Both files contain the query results.
The YAML can be placed in the `charts/` directory of a dbt-charts project and
rendered with `dct render charts/query-chart.yml`. Exports are snapshots, not
saved/live dashboards or recurring warehouse queries.

## Runtime

The existing authenticated Next.js proxy forwards `POST /charts/render` to
dbt-runner. No separate chart server or warehouse credentials are required.
The service builds a fixed inline-values board, runs `dct render` in a temporary
project, then removes the project. It never accepts executable board YAML, SQL,
source URLs or file paths. Auth is required except in the existing local no-auth
mode. Rendering receives a minimal environment without database credentials.

Two renders per worker can run simultaneously, with a 45-second deadline.
Requests exceeding capacity receive a retryable error. HTML is embedded in a
sandboxed iframe without same-origin access; a content security policy blocks
network requests in both the preview and exported HTML. Response caching is
disabled. The renderer uses bundled assets and does not call dbtcharts.com.

Dependency installation is covered by `dbt-runner/uv.lock`. To update the local
Docker app:

```sh
docker compose build dbt-runner frontend
docker compose up -d --no-deps dbt-runner frontend
```

## Verification

`dbt-runner/tests/test_charts.py` renders all eight supported types with the real
pinned engine and covers invalid fields, numeric/null handling, template input,
authentication, request limits and the structured diagnostic shape.
`nextjs/test/query-chart.unit.test.ts` covers numeric inference, value conversion
and the embedded/exported HTML policy; `nextjs/test/board.unit.test.ts` and
`nextjs/test/dashboard-guide.unit.test.ts` cover diagnostic labelling, the chart
builder's channels and every model template.

Browser verification on the Docker app exercised the Next.js proxy and real
renderer for bar/line charts, HTML/YAML downloads, clearing stale charts after
configuration changes, KPI validation and a 390px viewport. Project and SQL
result responses were browser fixtures; no warehouse data was created or changed.

## Saved dashboards in Explore

Explore → Dashboards is a full-height YAML workspace, separate from SQL result
snapshots. Save writes `charts/<name>.yml` in the selected project; open it again
from Saved dashboards. Files are Git-trackable but are not automatically committed.
A board is saved as authored — Save does not require a valid board, so work in
progress is not lost. Unsaved YAML is kept per project in browser storage and
restored on the next visit.

Validate checks authored YAML without querying the warehouse. Preview / Refresh
executes named SQL queries and renders all charts with the actual dbt-charts
engine, in **one** request: the renderer reports its own errors and returns the
board's filters, so a preview no longer costs a separate validation pass. Editing
the YAML keeps the last preview and the filter values already entered, marking
them out of date rather than discarding them. The editor stays beside the preview;
hide YAML for a full-width dashboard.

`dct` renders a misspelled column as an empty chart and still exits 0, so chart
fields are checked against the columns each query returned and refused by name
before rendering. Engine diagnostics keep their code, their suggested fix and the
**authored** line number (the compiler sees materialized YAML, whose line numbers
differ); selecting one moves the cursor to that line.

A new dashboard starts empty, and **Add chart** builds the first one from data
rather than from YAML: pick a model or source (which writes the starting SQL),
edit the SQL, run it, and choose fields from the columns it actually returned.
Adding writes both the query and the chart into the board, so a dashboard can be
built without typing YAML. A board query that already exists is the second source
on the same dialog. Ten authorable types are offered — bar, line, area, scatter,
pie, donut, histogram, heatmap, KPI and table — with an optional series column and
the engine's number-format aliases (`currency`, `percent`, `integer`…), which is
what silences the renderer's "unformatted measure" warning. Only some families own
a `number_format` slot: pie, donut and table reject it, and a KPI takes
`style.value.format` instead (`tests/test_boards.py` validates every offered type
with a format). The chart is inserted as text, so comments in an authored board
survive. A `grid` or `tabs` layout is left to the author to place the new chart in.

Explore → SQL and a dashboard build charts through the same configurator
(`ChartFields.tsx`), so the controls, the labels and the number formats are
identical; the SQL view renders a snapshot of the returned rows, a dashboard saves
the query that produced them. The toolbar names the open file and whether it is
saved, and saving a new dashboard names the file in a dialog — with the resulting
path, an overwrite warning and Save as… — rather than a browser prompt.

The Data panel browses the project's models, sources and columns and inserts a
`ref()` or a quoted column at the cursor; the YAML editor completes the same
metadata inside its SQL blocks. Data and YAML are icon toggles in the toolbar;
Validate and Samples and guide sit in its overflow menu, and the dashboard select
opens a new board, so the toolbar carries one control per job.

Samples and guide offers three starting points: templates built against one of
your models (category breakdown, KPI overview, trend over time, top values —
each writes real SQL with `ref()`, declares its filters and formats its numbers),
the complete board specimens bundled with the engine (inline data, so they render
without a warehouse), and the YAML reference shipped inside the installed
`dbt-charts` package, served by `GET /charts/reference` rather than written by
hand, so it cannot drift from the renderer.

From SQL → Chart → Build chart → Add to dashboard, choose a new or existing board.
The saved definition retains the executed SQL (not later editor changes), wraps
its columns with adapter-quoted aliases, and appends the chart without replacing
existing charts. Refresh re-executes the SQL, rather than reusing downloaded rows.

Supported boards contain named `queries`, named `charts`, and declarative layouts
such as `rows` / `cols`. Queries can be SQL strings or inline `columns` / `values`.
Static variables support select, multiselect, text, number, date and checkbox:

```yaml
variables:
  region:
    input: select
    options: {static: [US, EU]}
    default: US
queries:
  sales: |
    select month, sum(revenue) as revenue
    from {{ ref('sales') }}
    where {{ filter('region', region) }}
    group by month
charts:
  revenue: {type: bar, query: sales, x: month, y: revenue}
  trend: {type: line, query: sales, x: month, y: revenue}
rows:
  - cols: [revenue, trend]
```

Validate or Preview exposes filters above the preview. Change filters, then Refresh.
Unlike upstream's unrestricted local CLI, Explore accepts only a bounded subset:
12 queries, 24 charts, 20 variables, 1,000 rows per query. SQL allows a single
SELECT/WITH, literal `ref`/`source`/`adapter.quote`, declared variables and `filter`.
Arbitrary macros, unknown SQL functions, external files/URLs, includes, custom
themes and dynamically queried filter options are rejected. Use read-only warehouse
credentials: syntactic checks do not replace database privileges.

Project board endpoints validate ownership before validation, composition,
query or SQL preview, chart insertion or execution. Ad-hoc SQL from the chart
builder passes the same `prepare_sql` guard as a saved board query — one
SELECT/WITH, literal `ref`/`source`, no external functions. Only materialized inline results
reach the credential-free renderer. `tests/test_boards.py` exercises real
multi-chart rendering, filters, composition, auth/ownership checks, YAML
diagnostics, SQL rejection, unknown-column refusal, comment-preserving chart
insertion and the bundled samples. The browser regression
`nextjs/scripts/check-explore-boards.cjs` uses in-memory file fixtures and the real
local renderer; it does not execute warehouse SQL. Run it against a production
build — `next dev` serves Monaco's workers from `blob:` URLs, which the app's
content security policy blocks.

Upstream: https://github.com/dbt-labs/dbt-charts (Apache-2.0).
