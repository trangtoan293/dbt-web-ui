# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed
- Flow orchestration ("Workflows"): the DAG builder, task worker, cron
  scheduler, and their tables. Trigger runs from an external orchestrator
  instead — see [external orchestrator API](docs/external-orchestrator-api.md).
- The experimental `python-runner` service and Python execution endpoints. The
  guards were never a multi-tenant isolation boundary.
- Cloud warehouse connection types that the runner image had no dbt adapter for
  (Snowflake, BigQuery, Redshift, Trino, Athena, SQL Server, MySQL). Selecting
  them could only ever fail.
- Third-party analytics (Vercel Analytics and Google Analytics) from the
  frontend. This is self-hosted software and now ships no outbound telemetry.

### Changed
- URLs dropped the `/v2` prefix: `/develop`, `/runs`, `/explore`,
  `/connections`, `/settings`, `/login`, and `/` for the dashboard.

## 0.1.0 - unreleased

### Added
- Initial pre-release implementation of a web-based development environment for dbt.
- Next.js 15 frontend with SQL/Jinja editor, model tree, and live dbt run
  logs over Server-Sent Events.
- FastAPI dbt-runner service with PostgreSQL, DuckDB, Dremio, Oracle, and Spark
  adapters and per-project encrypted credentials.
- Multi-user authentication via Keycloak OIDC; per-project ownership.
- Per-project dbt environment variables.
- Docker Compose stack for local development.

### Notes
- Historical internal identifiers remain in configuration and file paths.
  They will be replaced after an independent public name receives clearance.
- No `v0.1.0` tag has been published. The API may change before 1.0.

[Unreleased]: https://github.com/trangtoan293/dbt-web-ui/commits/main
