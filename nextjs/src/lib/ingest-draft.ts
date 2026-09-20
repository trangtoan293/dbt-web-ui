/**
 * The load being written in the wizard, and the rules that move it forward.
 *
 * Kept out of the components so the decisions can be tested without rendering:
 * which step is incomplete and why, what a table should default to once its
 * columns are known, and what the destination tables will end up called. Those
 * three are the whole difference between the old form and this one — the form
 * asked, this proposes.
 */

import type {
  IngestSourceInput,
  IngestSourceType,
  IngestTableConfig,
} from '@/lib/ingest-source-validation'
import type { IngestPreviewResult } from '@/lib/api-client'

export type Destination = 'ducklake' | 'connection'

/** One tile on the first screen. */
export type SourceKind = {
  id: string
  label: string
  blurb: string
  /** How a source of this kind is read. */
  sourceType: IngestSourceType
  /** Connection types this kind reads through; empty means it needs none. */
  connectionTypes: string[]
  /** Whether a connection is required rather than merely possible. */
  requiresConnection: boolean
}

/**
 * The entry gallery. A dropdown of three source types hid the fact that this
 * platform reads Oracle at all, and made "a public API needs no credential"
 * something you only learned after choosing.
 */
export const SOURCE_KINDS: SourceKind[] = [
  {
    id: 'postgresql',
    label: 'PostgreSQL',
    blurb: 'Copy tables over SQL.',
    sourceType: 'sql_database',
    connectionTypes: ['postgresql'],
    requiresConnection: true,
  },
  {
    id: 'oracle',
    label: 'Oracle',
    blurb: 'Copy tables over SQL.',
    sourceType: 'sql_database',
    connectionTypes: ['oracle'],
    requiresConnection: true,
  },
  {
    id: 'mysql',
    label: 'MySQL',
    blurb: 'Copy tables over SQL. Read-only — dbt never runs against it.',
    sourceType: 'sql_database',
    connectionTypes: ['mysql'],
    requiresConnection: true,
  },
  {
    id: 'rest_api',
    label: 'REST API',
    blurb: 'Turn JSON endpoints into tables. A public API needs only a URL.',
    sourceType: 'rest_api',
    connectionTypes: ['rest'],
    requiresConnection: false,
  },
  {
    id: 'filesystem',
    label: 'Files on disk',
    blurb: 'Read CSV, JSONL or Parquet from a server directory.',
    sourceType: 'filesystem',
    connectionTypes: [],
    requiresConnection: false,
  },
]

export type Draft = {
  kindId: string
  sourceType: IngestSourceType
  connectionId: string
  tables: string[]
  tableConfig: Record<string, IngestTableConfig>
  sourceConfig: Record<string, unknown>
  projectId: string
  destination: Destination
  name: string
  dataset: string
  partitionBy: string
  /** Source-level cursor. Only REST still uses it: it sends one cursor for
   *  every resource, so a per-resource one could not be delivered. */
  cursorField: string
  cursorInitialValue: string
  writeDisposition: string
  primaryKey: string
  /** What happens when the source grows a column: 'evolve' or 'freeze'. */
  schemaContract: string
}

export function emptyDraft(kind: SourceKind, lakehouseConfigured: boolean): Draft {
  return {
    kindId: kind.id,
    sourceType: kind.sourceType,
    connectionId: '',
    tables: [],
    tableConfig: {},
    sourceConfig: {},
    projectId: '',
    destination: lakehouseConfigured ? 'ducklake' : 'connection',
    name: '',
    dataset: '',
    partitionBy: '',
    cursorField: '',
    cursorInitialValue: '',
    writeDisposition: 'append',
    primaryKey: '',
    // Today's behaviour is the default; freezing is the deliberate choice.
    schemaContract: 'evolve',
  }
}

/**
 * What a table should default to, once its columns have been read.
 *
 * The proposal is deliberately timid about the merge key — only a key the
 * source itself declares — and deliberately bold about the cursor, because a
 * blank cursor is the setting that quietly re-reads the whole warehouse every
 * night and nobody ever goes back to fix it.
 */
export function tableDefaults(preview: IngestPreviewResult): IngestTableConfig {
  const primaryKey = preview.primary_key ?? []
  return {
    cursorField: preview.suggested_cursor ?? null,
    writeDisposition: preview.suggested_write_disposition ?? 'append',
    primaryKey,
  }
}

/**
 * What a table will be called in the destination.
 *
 * An approximation of dlt's snake_case naming convention, shown so nobody is
 * surprised by `CUSTOMER_ADDRESS` arriving as `customer_address`. dlt does the
 * real normalisation at load time; this only has to agree with it often enough
 * to be worth showing.
 */
export function destinationTableName(source: string): string {
  return source
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
}

export function qualifiedTableNames(draft: Draft): string[] {
  const prefix = draft.destination === 'ducklake' ? 'lake' : 'warehouse'
  return draft.tables.map(
    (table) => `${prefix}.${draft.dataset || '<schema>'}.${destinationTableName(table)}`,
  )
}

const DATASET_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

export const WIZARD_STEPS = ['Source', 'Connection', 'Data', 'Destination', 'Finish'] as const
export type WizardStep = 0 | 1 | 2 | 3 | 4

/**
 * Why this step cannot be left, in the user's words, or null when it can.
 *
 * One function rather than a check per control: the wizard needs the same
 * answer for the Continue button, for the summary on the last step, and for
 * the Save that has to refuse if someone jumped back and broke an earlier step.
 */
export function stepProblem(
  draft: Draft,
  step: WizardStep,
  context: { kind: SourceKind; fileRootsConfigured: boolean; projectHasLake: boolean },
): string | null {
  const { kind } = context

  if (step === 1) {
    if (kind.requiresConnection && !draft.connectionId) {
      return `Choose a ${kind.label} connection to read through.`
    }
    if (draft.sourceType === 'filesystem' && !context.fileRootsConfigured) {
      return 'File loads are switched off on this server: no ingest roots are configured.'
    }
    if (draft.sourceType === 'filesystem' && !String(draft.sourceConfig.bucket_url ?? '').trim()) {
      return 'Choose a directory to read from.'
    }
    return null
  }

  if (step === 2) {
    if (!draft.tables.length) return 'Select at least one table to load.'
    // The base URL sits on this step for REST, beside the endpoints that hang
    // off it - naming a resource is what makes an endpoint path mean anything.
    if (
      draft.sourceType === 'rest_api' &&
      !draft.connectionId &&
      !String(draft.sourceConfig.base_url ?? '').trim()
    ) {
      return 'Enter the API base URL, or pick a connection that carries one.'
    }
    if (draft.sourceType === 'filesystem' && draft.tables.length !== 1) {
      return 'A file load writes one directory into one table.'
    }
    const needsKey = draft.tables.filter((table) => {
      const config = draft.tableConfig[table] ?? {}
      const disposition = config.writeDisposition ?? draft.writeDisposition
      const key = config.primaryKey?.length ? config.primaryKey : parseList(draft.primaryKey)
      return disposition === 'merge' && !key.length
    })
    if (needsKey.length) {
      return `${needsKey[0]} updates matching rows but has no primary key. Choose one, or change how it updates.`
    }
    return null
  }

  if (step === 3) {
    if (!draft.projectId) return 'Choose the project this load belongs to.'
    if (!DATASET_PATTERN.test(draft.dataset)) {
      return 'The destination schema must start with a lowercase letter and use only lowercase letters, digits and underscores.'
    }
    if (draft.destination === 'ducklake' && !context.projectHasLake) {
      return 'This project has no lakehouse attached yet.'
    }
    return null
  }

  if (step === 4 && !draft.name.trim()) return 'Give this load a name.'
  return null
}

export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** The draft as the server action takes it. */
export function draftToInput(draft: Draft): IngestSourceInput {
  const tableConfig: Record<string, IngestTableConfig> = {}
  // Only what a table actually overrides. Writing every table's resolved values
  // would freeze today's source-level defaults into each row, so changing the
  // load-wide setting later would stop reaching the tables it should.
  for (const table of draft.tables) {
    const config = draft.tableConfig[table]
    if (!config) continue
    const entry: IngestTableConfig = {}
    if (config.cursorField) entry.cursorField = config.cursorField
    if (config.cursorInitialValue) entry.cursorInitialValue = config.cursorInitialValue
    if (config.writeDisposition) entry.writeDisposition = config.writeDisposition
    if (config.primaryKey?.length) entry.primaryKey = config.primaryKey
    if (Object.keys(entry).length) tableConfig[table] = entry
  }

  return {
    projectId: draft.projectId,
    sourceConnectionId: draft.sourceType === 'filesystem' ? null : draft.connectionId || null,
    sourceType: draft.sourceType,
    name: draft.name.trim(),
    dataset: draft.dataset,
    tables: draft.tables,
    tableConfig: Object.keys(tableConfig).length ? tableConfig : null,
    sourceConfig: draft.sourceType === 'sql_database' ? null : normalisedSourceConfig(draft),
    cursorField: draft.cursorField.trim() || null,
    cursorInitialValue: draft.cursorInitialValue.trim() || null,
    destination: draft.destination,
    writeDisposition: draft.writeDisposition,
    schemaContract: draft.schemaContract,
    primaryKey: parseList(draft.primaryKey),
    // Only the lake has a Parquet layout to partition; the server refuses the
    // combination, so it is not sent.
    partitionBy: draft.destination === 'ducklake' ? parseList(draft.partitionBy) : [],
  }
}

/** The chosen type's own fields only — a stale glob must not reach a REST source. */
function normalisedSourceConfig(draft: Draft): Record<string, unknown> {
  if (draft.sourceType === 'filesystem') {
    return {
      bucket_url: draft.sourceConfig.bucket_url ?? '',
      file_glob: draft.sourceConfig.file_glob || '*',
      format: draft.sourceConfig.format ?? 'csv',
    }
  }
  const config = draft.sourceConfig as {
    base_url?: string
    paginator?: unknown
    resources?: Array<Record<string, unknown>>
  }
  const byName = new Map((config.resources ?? []).map((r) => [String(r.name), r]))
  return {
    base_url: (config.base_url ?? '').trim(),
    paginator: config.paginator ?? { type: 'auto' },
    // Driven by the table list so every table gets an endpoint, defaulting to
    // its own name.
    resources: draft.tables.map((table) => {
      const resource = byName.get(table) ?? { name: table }
      return {
        name: table,
        path: resource.path || table,
        ...(resource.data_selector ? { data_selector: resource.data_selector } : {}),
        ...(resource.params && Object.keys(resource.params).length
          ? { params: resource.params }
          : {}),
        ...(draft.cursorField.trim() && resource.incremental_param
          ? { incremental_param: resource.incremental_param }
          : {}),
      }
    }),
  }
}
