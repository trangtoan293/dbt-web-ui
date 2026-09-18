/**
 * What an ingest source may contain, checked before it is stored.
 *
 * Extracted from the server action so it can be unit-tested without a database:
 * every value here becomes a SQL identifier, a filesystem path or a URL on the
 * dbt-runner side, and that side is the enforcing one. This is the earlier, more
 * useful refusal - a 400 while saving rather than a failed load an hour later.
 */

const DATASET_PATTERN = /^[a-z][a-z0-9_]{0,39}$/
const TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const WRITE_DISPOSITIONS = new Set(['append', 'replace', 'merge'])
// A partition term reaches DuckLake as DDL, not as a bound parameter: a bare
// column, or one date-part function over one. Kept in step with
// dbt-runner/ingest/lakehouse.py:_PARTITION_TERM_RE, which is the enforcing side.
const PARTITION_TERM_PATTERN =
  /^(?:(?:year|month|day|hour)\([A-Za-z_][A-Za-z0-9_$]{0,62}\)|[A-Za-z_][A-Za-z0-9_$]{0,62})$/i
const PARTITION_FUNCTIONS = ['year', 'month', 'day', 'hour']

const SOURCE_TYPES = new Set(['sql_database', 'rest_api', 'filesystem'])
/** Source kinds that carry no credential, so they need no connection row. */
const CONNECTIONLESS_SOURCE_TYPES = new Set(['filesystem'])
const FILE_FORMATS = new Set(['csv', 'jsonl', 'parquet'])
// A cursor is a source column name - it reaches SQL as an identifier. For
// rest_api it is dlt's `cursor_path` into the response body instead, which never
// reaches SQL and is usually dotted. Mirrors _CURSOR_RE / _JSON_CURSOR_RE in
// dbt-runner/app/routers/ingest.py, which is the enforcing side.
const CURSOR_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/
const JSON_CURSOR_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}(\.[A-Za-z_][A-Za-z0-9_$]{0,62}){0,9}$/

export type IngestSourceType = 'sql_database' | 'rest_api' | 'filesystem'

export type IngestSourceInput = {
  projectId: string
  /** Absent for a filesystem source, and for a public API needing no key. */
  sourceConnectionId?: string | null
  sourceType?: IngestSourceType
  name: string
  dataset: string
  tables: string[]
  /** Per-type configuration: a REST client and its resources, or a file glob. */
  sourceConfig?: Record<string, unknown> | null
  cursorField?: string | null
  cursorInitialValue?: string | null
  destination?: 'connection' | 'ducklake'
  writeDisposition?: string
  primaryKey?: string[]
  partitionBy?: string[]
}

/** Reject anything that would reach SQL as an identifier, before it is stored. */
export function validateIngestSource(input: IngestSourceInput) {
  if (!input.name?.trim()) throw new Error('Name is required')
  if (!DATASET_PATTERN.test(input.dataset ?? '')) {
    throw new Error(
      'Dataset must start with a letter and use only lowercase letters, digits and underscores (max 40 characters)',
    )
  }
  if (!Array.isArray(input.tables) || input.tables.length === 0) {
    throw new Error('Select at least one table')
  }
  const badTables = input.tables.filter((t) => !TABLE_PATTERN.test(t))
  if (badTables.length) throw new Error(`Invalid table name(s): ${badTables.slice(0, 5).join(', ')}`)

  const disposition = input.writeDisposition ?? 'append'
  if (!WRITE_DISPOSITIONS.has(disposition)) {
    throw new Error(`writeDisposition must be one of ${[...WRITE_DISPOSITIONS].join(', ')}`)
  }
  if (disposition === 'merge' && !input.primaryKey?.length) {
    throw new Error('A primary key is required for merge')
  }

  for (const term of input.partitionBy ?? []) {
    if (!PARTITION_TERM_PATTERN.test(term)) {
      throw new Error(
        `Invalid partition term "${term}": use a column name, or ${PARTITION_FUNCTIONS.join('/')}(column)`,
      )
    }
  }
  if (input.partitionBy?.length && (input.destination ?? 'ducklake') !== 'ducklake') {
    throw new Error('Partitioning applies to the lakehouse destination only')
  }

  const sourceType = input.sourceType ?? 'sql_database'
  if (!SOURCE_TYPES.has(sourceType)) {
    throw new Error(`sourceType must be one of ${[...SOURCE_TYPES].join(', ')}`)
  }
  // A SQL source reads over a connection, so without one there is nothing to
  // read. The other two may or may not have one, which is why this is not a
  // single required field.
  if (sourceType === 'sql_database' && !input.sourceConnectionId) {
    throw new Error('A SQL source needs a connection to read from')
  }
  if (CONNECTIONLESS_SOURCE_TYPES.has(sourceType) && input.sourceConnectionId) {
    throw new Error('A filesystem source reads a path, not a connection')
  }

  const cursorPattern = sourceType === 'rest_api' ? JSON_CURSOR_PATTERN : CURSOR_PATTERN
  if (input.cursorField && !cursorPattern.test(input.cursorField)) {
    throw new Error(
      sourceType === 'rest_api'
        ? `Invalid cursor "${input.cursorField}": use field names separated by dots`
        : `Invalid cursor field "${input.cursorField}": it must be a column name`,
    )
  }
  if (input.cursorInitialValue && !input.cursorField) {
    throw new Error('An initial value needs a cursor field to apply to')
  }

  const config = input.sourceConfig ?? {}
  if (sourceType === 'filesystem') {
    if (input.tables.length !== 1) {
      throw new Error('A filesystem source loads one directory into one table')
    }
    if (!String(config.bucket_url ?? '').trim()) {
      throw new Error('A filesystem source needs a directory to read from')
    }
    const format = String(config.format ?? 'csv')
    if (!FILE_FORMATS.has(format)) {
      throw new Error(`Format must be one of ${[...FILE_FORMATS].join(', ')}`)
    }
  }
  if (sourceType === 'rest_api') {
    const resources = Array.isArray(config.resources) ? config.resources : []
    if (resources.length === 0) throw new Error('A REST source needs at least one resource')
    const names = resources.map((r) => String((r as { name?: unknown })?.name ?? ''))
    const missing = input.tables.filter((t) => !names.includes(t))
    if (missing.length) {
      throw new Error(`No endpoint configured for table(s): ${missing.slice(0, 5).join(', ')}`)
    }
    const extra = names.filter((n) => !input.tables.includes(n))
    if (extra.length) {
      throw new Error(`Resource(s) not in the table list: ${extra.slice(0, 5).join(', ')}`)
    }
    // The base URL may live on the connection instead, which is how one API with
    // one key serves several sources.
    if (!String(config.base_url ?? '').trim() && !input.sourceConnectionId) {
      throw new Error('A REST source needs a base URL, or a connection that carries one')
    }
    // dlt's offset paginator takes `limit` as a required argument, so without one
    // the load dies inside dlt rather than here. Mirrors _validate_paginator in
    // dbt-runner/ingest/rest_source.py, which is the enforcing side.
    const paginator = (config.paginator ?? {}) as { type?: unknown; limit?: unknown }
    if (String(paginator.type ?? 'auto') === 'offset' && !String(paginator.limit ?? '').trim()) {
      throw new Error('The offset paginator needs a records-per-page value (limit)')
    }
  }
}
