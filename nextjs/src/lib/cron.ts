/**
 * Cron shape check.
 *
 * Deliberately not a parser: the runner parses cron with croniter and
 * `GET /dbt/cron/preview` is the authority on whether an expression is valid and
 * when it fires. This only rejects obvious junk at the write boundary, so a
 * malformed schedule fails while saving instead of silently never running.
 *
 * Lives outside lib/actions/data.ts because that file is `use server` — every
 * export there must be an async server action.
 */

const CRON_FIELD_PATTERN = /^[0-9*/,\-A-Za-z]+$/
const CRON_FIELDS = 5
const MAX_FIELD_LENGTH = 40

export function isPlausibleCron(expression: string): boolean {
  const fields = (expression ?? '').trim().split(/\s+/)
  if (fields.length !== CRON_FIELDS) return false
  return fields.every(
    (field) => field.length <= MAX_FIELD_LENGTH && CRON_FIELD_PATTERN.test(field),
  )
}
