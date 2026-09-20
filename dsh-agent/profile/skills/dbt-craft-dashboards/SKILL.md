---
name: dbt-craft-dashboards
description: How to build or change a dashboard, board, chart or KPI in this deployment - a board is one YAML file under charts/, dbt-craft accepts a subset of the dbt-charts syntax, and there is no dct CLI or dbt_charts.yml to look for.
whenToUse: The user asks for a dashboard, a board, a chart, a KPI or a visualisation, or wants an existing file under charts/ changed.
---

# Dashboards in dbt-craft

A dashboard is **one YAML file under `charts/`** in this project. Nothing else
is involved: no CLI, no project-level config, no registry to update.

## The loop

1. `mcp__dbt__list_models` for model names, then `read` the model's `.sql` and
   its `schema.yml` for real column names. Never invent one.
2. `mcp__dbt__query` to see the actual shape of the data before charting it.
   A chart built on a guessed column fails at Preview, in front of the user.
3. `mcp__dbt__charts_reference` for syntax — start with no topic for the index,
   then read the one topic you need. Its `explore_subset` field outranks the
   prose around it.
4. `mcp__dbt__validate_dashboard` on the YAML **before** writing it. Diagnostics
   carry line numbers.
5. `write` the file to `charts/<name>.yml`, then tell the user which file to
   open and to press **Preview** in Explore. You cannot render it yourself, and
   rendering is not needed to know the board is correct — validation is.

## What this deployment accepts

The renderer documents its full syntax, which assumes its own CLI. Explore runs
the queries itself and accepts a subset. `explore_subset` from
`charts_reference` is the authoritative list; the parts people get wrong:

- A query is a **plain SQL string**: `queries.daily: |` then the SQL. A mapping
  with a `sql:` key is refused — `sql` is a blocked key.
- **No `source:`, `connection:`, `file:`, `path:`, `url:`, `extends:`.** Queries
  run against this project's own dbt profile; the user picks the environment
  with *Run on*. Naming a source is the single most common rejection.
- `queries` and `variables` only at the board root. Every `chart.query` must
  name a query defined there.
- `{{ }}` only inside a query string, and only `ref()`, `source()`,
  `adapter.quote()`, variables and `filter()`.
- Filters are `variables` with `options.static`, applied in SQL with `filter()`.

## Saved SQL

Reusable SQL belongs in `analyses/explore/<name>.sql`, which is what the
**Saved queries** dialog lists. It is a plain file — writing it is enough.

## Do not

- **Do not shell out.** `read`, `glob` and `grep` cover listing and reading, and
  they stay inside this project. A `find` from `/` reaches other people's
  projects and tells you nothing this project does not.
- **Do not `chmod`.** Files are written owner-only on purpose; dbt-runner runs
  as the same uid and reads them fine. A permission that looks wrong is not why
  something failed.
- **Do not hunt for `dct`, `dbt_charts.yml`, or a `target/` artefact.** They are
  not part of this deployment.
