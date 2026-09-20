/**
 * The decisions the load wizard makes on the user's behalf.
 *
 * Three things are worth pinning: a table's proposed settings (a wrong cursor
 * is editable, a blank one silently re-reads the warehouse forever), the
 * destination names shown before anything is written, and which step refuses to
 * advance and with what sentence.
 */

import { describe, it, expect } from 'vitest'
import {
  SOURCE_KINDS,
  destinationTableName,
  draftToInput,
  emptyDraft,
  qualifiedTableNames,
  stepProblem,
  tableDefaults,
  type Draft,
} from '@/lib/ingest-draft'
import type { IngestPreviewResult } from '@/lib/api-client'

const ORACLE = SOURCE_KINDS.find((k) => k.id === 'oracle')!
const REST = SOURCE_KINDS.find((k) => k.id === 'rest_api')!

function draft(overrides: Partial<Draft> = {}): Draft {
  return { ...emptyDraft(ORACLE, true), ...overrides }
}

function preview(overrides: Partial<IngestPreviewResult> = {}): IngestPreviewResult {
  return {
    success: true,
    columns: [],
    rows: [],
    primary_key: [],
    suggested_cursor: null,
    suggested_write_disposition: 'replace',
    files: [],
    ...overrides,
  }
}

const CONTEXT = { kind: ORACLE, fileRootsConfigured: true, projectHasLake: true }

describe('what a table defaults to once its columns are known', () => {
  it('takes the cursor and disposition the server proposed', () => {
    expect(
      tableDefaults(
        preview({ suggested_cursor: 'UPDATED_AT', suggested_write_disposition: 'merge', primary_key: ['ID'] }),
      ),
    ).toEqual({ cursorField: 'UPDATED_AT', writeDisposition: 'merge', primaryKey: ['ID'] })
  })

  it('leaves the merge key empty when the source declares none', () => {
    // A guessed key that is not unique drops rows on every load.
    expect(tableDefaults(preview({ suggested_write_disposition: 'append' })).primaryKey).toEqual([])
  })
})

describe('the names the destination will actually use', () => {
  it('lowercases and snake-cases, the way dlt does', () => {
    expect(destinationTableName('CUSTOMER_ADDRESS')).toBe('customer_address')
    expect(destinationTableName('custAddress')).toBe('cust_address')
    expect(destinationTableName('Order Items')).toBe('order_items')
  })

  it('qualifies them so nobody is surprised by where the rows land', () => {
    expect(
      qualifiedTableNames(draft({ dataset: 'raw_core', tables: ['CUSTOMERS'], destination: 'ducklake' })),
    ).toEqual(['lake.raw_core.customers'])
  })
})

describe('why a step will not advance', () => {
  it('asks for a connection before anything else', () => {
    expect(stepProblem(draft(), 1, CONTEXT)).toMatch(/Oracle connection/)
  })

  it('lets a public API past the connection step with no credential at all', () => {
    expect(stepProblem(emptyDraft(REST, true), 1, { ...CONTEXT, kind: REST })).toBeNull()
  })

  it('asks for the API base URL beside the resources, not before them', () => {
    // The endpoints hang off it, and naming a resource is what makes an
    // endpoint path mean anything - so both live on the data step.
    const rest = { ...emptyDraft(REST, true), tables: ['orders'] }
    expect(stepProblem(rest, 2, { ...CONTEXT, kind: REST })).toMatch(/base URL/)
    expect(
      stepProblem(
        { ...rest, sourceConfig: { base_url: 'https://api.example.com' } },
        2,
        { ...CONTEXT, kind: REST },
      ),
    ).toBeNull()
  })

  it('names the table that wants to merge without a key', () => {
    const d = draft({
      connectionId: 'c1',
      tables: ['ORDERS', 'REGIONS'],
      tableConfig: { REGIONS: { writeDisposition: 'merge' } },
    })
    expect(stepProblem(d, 2, CONTEXT)).toMatch(/REGIONS/)
  })

  it('lets a table merge on the load-wide key', () => {
    const d = draft({
      connectionId: 'c1',
      tables: ['ORDERS'],
      primaryKey: 'id',
      tableConfig: { ORDERS: { writeDisposition: 'merge' } },
    })
    expect(stepProblem(d, 2, CONTEXT)).toBeNull()
  })

  it('refuses a lakehouse destination on a project that has no lake', () => {
    const d = draft({ projectId: 'p1', dataset: 'raw_core' })
    expect(stepProblem(d, 3, { ...CONTEXT, projectHasLake: false })).toMatch(/lakehouse/)
  })
})

describe('what is sent to the server', () => {
  it('sends no tableConfig at all when no table overrode anything', () => {
    const input = draftToInput(draft({ projectId: 'p1', dataset: 'raw', tables: ['A'], name: 'x' }))
    expect(input.tableConfig).toBeNull()
  })

  it('sends only the fields a table actually overrode', () => {
    const input = draftToInput(
      draft({
        projectId: 'p1',
        dataset: 'raw',
        tables: ['A', 'B'],
        name: 'x',
        tableConfig: { A: { cursorField: 'UPDATED_AT', primaryKey: [] }, B: {} },
      }),
    )
    expect(input.tableConfig).toEqual({ A: { cursorField: 'UPDATED_AT' } })
  })

  it('drops partitioning when the destination is not the lake', () => {
    const input = draftToInput(
      draft({ projectId: 'p1', dataset: 'raw', tables: ['A'], name: 'x', destination: 'connection', partitionBy: 'month(created_at)' }),
    )
    expect(input.partitionBy).toEqual([])
  })

  it('sends no source config for a database source', () => {
    const input = draftToInput(draft({ projectId: 'p1', dataset: 'raw', tables: ['A'], name: 'x' }))
    expect(input.sourceConfig).toBeNull()
  })
})
