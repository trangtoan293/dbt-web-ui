# Data workspace

The default `/data` page is an operational list of saved data loads. There is no introductory Overview or journey page. `/data?tab=sources` and the former overview URL open the same list; `/connections` still redirects to `/data?tab=connections`.

| Section | User intent | Boundary |
| --- | --- | --- |
| Data loads | Manage data movement | Saved load/project, source, destination schema, update rule and run/history actions |
| Lakehouse | Share lake tables | Existing Iceberg publishing; catalog browsing and SQL remain in Explore |
| Connections | Configure system access | Reusable connection details, testing, editing and dependency-aware deletion |

Connections provide access; ingestion sources describe loads; the lakehouse is an optional destination. Creating a connection does not ingest data. Files and public APIs may not require one. A project must exist before saving an ingestion source. Users whose warehouse already contains data can go directly from connections to dbt development.

## Interaction decisions

- Section navigation uses URLs as its source of truth, so Back/Forward, bookmarks and internal links select the correct content.
- Existing connection-specific shortcuts on Home and project creation open Connections directly.
- The load list shows real definition counts, search, project filters and refresh. It does not infer run health from saved definitions.
- New and edited loads use three steps: Choose data → Destination → Update rules. Continue validates prerequisites; Back preserves input. Saving a definition does not run a load.
- Source-specific fields appear in the first step; destination project/schema in the second; append/replace/merge, incremental tracking and partition settings in the last step.
- API incremental query parameters appear alongside incremental tracking in the final step.
- Search filters connections and loads; empty search results differ from a new workspace or failed request.
- Iceberg publishing is optional, disabled until configuration is confirmed, and distinct from browsing data.
- File-source availability is forwarded from the existing ingestion metadata endpoint to the creation form.
- The load table becomes vertically stacked records on narrow screens.

## Verification

The three-step database flow, missing-project validation and populated list were checked with browser-only fixtures; no load was submitted or run. Empty-state checks used the real workspace. Existing ingestion validation and legacy-route tests remain applicable.

## References

The design adapts the separation of ingestion, data discovery and connection configuration described in vendor documentation. It does not assume this app implements Unity Catalog or Snowflake's object model.

- [Snowflake: Snowsight navigation](https://docs.snowflake.com/en/user-guide/ui-snowsight-navigation)
- [Snowflake: Load data using Snowsight](https://docs.snowflake.com/en/user-guide/data-load-web-ui)
- [Databricks: Catalog Explorer](https://docs.databricks.com/aws/en/catalog-explorer)
- [Databricks: Unity Catalog connections](https://docs.databricks.com/aws/en/connect/uc-connections)
