import { describe, expect, it } from 'vitest'
import { BOARD_TEMPLATES, modelDashboard } from '@/lib/dashboard-guide'
import type { DataEntry } from '@/lib/explore-data'

const model: DataEntry = { id: 'model.sales.orders', name: 'orders', kind: 'model', path: 'models/orders.sql', expression: '{{ ref("sales", "orders") }}', columns: [{ name: 'region' }, { name: 'amount' }] }
describe('guided dashboard template', () => {
  it('uses the selected project reference and columns, with declared filters and two charts', () => {
    const yaml = modelDashboard(model, 'region', 'amount')
    expect(yaml).toContain(model.expression)
    expect(yaml).toContain('adapter.quote("region")')
    expect(yaml).toContain('adapter.quote("amount")')
    expect(yaml).toContain("filter('group_key', category)")
    expect(yaml).toContain('min_value:')
    expect(yaml).toContain('measure_value >= {{ min_value }}')
    expect(yaml).toContain('cols: [overview, details]')
  })
  it('rejects fields absent from the model', () => {
    expect(() => modelDashboard(model, 'missing', 'amount')).toThrow()
  })
})

const dated: DataEntry = { ...model, columns: [{ name: 'region' }, { name: 'amount' }, { name: 'ordered_at' }] }
describe('board templates', () => {
  it.each(BOARD_TEMPLATES)('$id builds SQL against the model with formatted numbers', (template) => {
    const yaml = template.build(dated, { dimension: 'region', measure: 'amount', date: 'ordered_at' })
    expect(yaml).toContain(dated.expression)
    expect(yaml).toContain('adapter.quote("amount")')
    expect(yaml).toMatch(/format: (number|integer)/)
    expect(yaml).toMatch(/^charts:$/m)
    expect(yaml).toMatch(/^(rows|cols|grid|tabs):$/m)
  })

  it('refuses a column the model does not have', () => {
    const picks = { dimension: 'region', measure: 'amount', date: 'ordered_at' }
    for (const template of BOARD_TEMPLATES) {
      for (const field of template.fields) {
        expect(() => template.build(dated, { ...picks, [field]: 'missing' })).toThrow()
        expect(() => template.build(dated, { ...picks, [field]: '' })).toThrow()
      }
    }
  })

  it('declares every template filter as a variable it also uses', () => {
    for (const template of BOARD_TEMPLATES) {
      const yaml = template.build(dated, { dimension: 'region', measure: 'amount', date: 'ordered_at' })
      for (const [, name] of yaml.matchAll(/\{\{ (\w+) \}\}/g)) expect(yaml).toContain(`  ${name}:`)
      for (const [, name] of yaml.matchAll(/filter\('[^']+', (\w+)\)/g)) expect(yaml).toContain(`  ${name}:`)
    }
  })
})
