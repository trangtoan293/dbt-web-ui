/**
 * What an ingest source may contain.
 *
 * dbt-runner enforces all of this again — these values become SQL identifiers,
 * filesystem paths and URLs there. What is pinned here is that a bad source is
 * refused while saving rather than an hour into a failed load, and that each
 * source type is held to its own rules rather than to a lowest common one.
 */

import { describe, it, expect } from 'vitest'
import {
  validateIngestSource,
  type IngestSourceInput,
} from '@/lib/ingest-source-validation'

function sqlSource(overrides: Partial<IngestSourceInput> = {}): IngestSourceInput {
  return {
    projectId: 'p1',
    sourceConnectionId: 'c1',
    name: 'CRM sync',
    dataset: 'raw_crm',
    tables: ['customers'],
    ...overrides,
  }
}

function restSource(overrides: Partial<IngestSourceInput> = {}): IngestSourceInput {
  return sqlSource({
    sourceType: 'rest_api',
    sourceConnectionId: null,
    tables: ['orders'],
    sourceConfig: {
      base_url: 'https://api.example.com/v1',
      resources: [{ name: 'orders', path: 'orders' }],
    },
    ...overrides,
  })
}

function fileSource(overrides: Partial<IngestSourceInput> = {}): IngestSourceInput {
  return sqlSource({
    sourceType: 'filesystem',
    sourceConnectionId: null,
    tables: ['dropped_files'],
    sourceConfig: { bucket_url: '/data/drop', format: 'csv' },
    ...overrides,
  })
}

describe('ingest source validation', () => {
  it('accepts the three source types and refuses anything else', () => {
    expect(() => validateIngestSource(sqlSource())).not.toThrow()
    expect(() => validateIngestSource(restSource())).not.toThrow()
    expect(() => validateIngestSource(fileSource())).not.toThrow()
    expect(() =>
      validateIngestSource(sqlSource({ sourceType: 'python_script' as never })),
    ).toThrow(/sourceType/)
  })

  it('defaults to sql_database, so existing rows keep working', () => {
    expect(() => validateIngestSource(sqlSource({ sourceType: undefined }))).not.toThrow()
  })

  describe('connections', () => {
    it('a SQL source without a connection has nothing to read', () => {
      expect(() => validateIngestSource(sqlSource({ sourceConnectionId: null }))).toThrow(
        /needs a connection/,
      )
    })

    it('a filesystem source reads a path, so a connection is a mistake', () => {
      expect(() => validateIngestSource(fileSource({ sourceConnectionId: 'c1' }))).toThrow(
        /reads a path/,
      )
    })

    it('a REST source may have a connection or not', () => {
      expect(() => validateIngestSource(restSource())).not.toThrow()
      expect(() =>
        validateIngestSource(restSource({ sourceConnectionId: 'c1' })),
      ).not.toThrow()
    })
  })

  describe('the incremental cursor', () => {
    it('must be a column name, because it reaches SQL as one', () => {
      expect(() => validateIngestSource(sqlSource({ cursorField: 'updated_at' }))).not.toThrow()
      for (const bad of ['updated_at; DROP TABLE x', 'a b', '1col', "x'y"]) {
        expect(() => validateIngestSource(sqlSource({ cursorField: bad }))).toThrow(
          /cursor field/i,
        )
      }
    })

    it('an initial value with no cursor would silently do nothing', () => {
      expect(() =>
        validateIngestSource(sqlSource({ cursorInitialValue: '2026-01-01' })),
      ).toThrow(/needs a cursor field/)
    })

    it('is optional - a source with no cursor is valid, just a full read', () => {
      expect(() => validateIngestSource(sqlSource({ cursorField: null }))).not.toThrow()
    })

    it('for a REST source it is a JSON path, so a dotted field is ordinary', () => {
      // dlt takes it as `cursor_path` into the response body; it never reaches
      // SQL, and plenty of APIs nest their timestamp.
      expect(() =>
        validateIngestSource(restSource({ cursorField: 'attributes.updated_at' })),
      ).not.toThrow()
      expect(() =>
        validateIngestSource(sqlSource({ cursorField: 'attributes.updated_at' })),
      ).toThrow(/column name/i)
    })

    it('a REST path is still a path - nothing that could carry a quote', () => {
      for (const bad of ['a.b; DROP TABLE x', 'a..b', 'a.', "a.b'c"]) {
        expect(() => validateIngestSource(restSource({ cursorField: bad }))).toThrow(
          /cursor/i,
        )
      }
    })
  })

  describe('filesystem sources', () => {
    it('load one directory into one table', () => {
      expect(() =>
        validateIngestSource(fileSource({ tables: ['a', 'b'] })),
      ).toThrow(/one directory into one table/)
    })

    it('need a directory', () => {
      expect(() =>
        validateIngestSource(fileSource({ sourceConfig: { format: 'csv' } })),
      ).toThrow(/directory to read from/)
    })

    it('refuse a format nothing can read', () => {
      expect(() =>
        validateIngestSource(
          fileSource({ sourceConfig: { bucket_url: '/data/drop', format: 'xlsx' } }),
        ),
      ).toThrow(/Format must be one of/)
    })
  })

  describe('REST sources', () => {
    it('need at least one resource', () => {
      expect(() =>
        validateIngestSource(
          restSource({ sourceConfig: { base_url: 'https://a.example/', resources: [] } }),
        ),
      ).toThrow(/at least one resource/)
    })

    it('keep the resource names and the table list in step, both ways', () => {
      expect(() =>
        validateIngestSource(restSource({ tables: ['orders', 'invoices'] })),
      ).toThrow(/No endpoint configured/)
      expect(() =>
        validateIngestSource(
          restSource({
            sourceConfig: {
              base_url: 'https://a.example/',
              resources: [
                { name: 'orders', path: 'orders' },
                { name: 'extra', path: 'extra' },
              ],
            },
          }),
        ),
      ).toThrow(/not in the table list/)
    })

    it('need a base URL somewhere - here, or on a connection', () => {
      expect(() =>
        validateIngestSource(
          restSource({ sourceConfig: { resources: [{ name: 'orders', path: 'orders' }] } }),
        ),
      ).toThrow(/base URL/)
      expect(() =>
        validateIngestSource(
          restSource({
            sourceConnectionId: 'c1',
            sourceConfig: { resources: [{ name: 'orders', path: 'orders' }] },
          }),
        ),
      ).not.toThrow()
    })
  })

  describe('the rules that predate source types still hold', () => {
    it('a dataset becomes a schema name', () => {
      expect(() => validateIngestSource(sqlSource({ dataset: 'Raw-CRM' }))).toThrow(/Dataset/)
    })

    it('merge needs a primary key', () => {
      expect(() =>
        validateIngestSource(sqlSource({ writeDisposition: 'merge' })),
      ).toThrow(/primary key/)
    })

    it('partitioning is a lakehouse-only property', () => {
      expect(() =>
        validateIngestSource(
          sqlSource({ destination: 'connection', partitionBy: ['month(created_at)'] }),
        ),
      ).toThrow(/lakehouse destination only/)
    })
  })
})
