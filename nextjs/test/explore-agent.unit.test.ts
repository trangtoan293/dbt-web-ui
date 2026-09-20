import { describe, expect, it } from 'vitest'
import { exploreAgentContext, exploreFileView } from '@/lib/explore-agent'

describe('exploreAgentContext', () => {
  it('names the dashboard tools so the agent does not invent board YAML', () => {
    const context = exploreAgentContext({ view: 'dashboards', dashboardPath: 'charts/sales.yaml' })
    expect(context).toContain('mcp__dbt__charts_reference')
    expect(context).toContain('mcp__dbt__validate_dashboard')
    expect(context).toContain('charts/sales.yaml')
  })

  it('carries the open SQL, which is what "this query" means', () => {
    const context = exploreAgentContext({ view: 'sql', queryName: 'Revenue', sql: 'select 1' })
    expect(context).toContain('"Revenue"')
    expect(context).toContain('select 1')
  })

  it('truncates a long scratchpad rather than sending the whole file', () => {
    const context = exploreAgentContext({ view: 'sql', sql: 'x'.repeat(5000) })
    expect(context.length).toBeLessThan(4000)
  })

  it('leaves the SQL fence out when the tab is empty', () => {
    expect(exploreAgentContext({ view: 'sql', sql: '   ' })).not.toContain('```')
  })

  it('states the target only when the user picked one', () => {
    expect(exploreAgentContext({ view: 'sql' })).not.toContain('target')
    expect(exploreAgentContext({ view: 'sql', target: 'prod' })).toContain('"prod" target')
  })
})

describe('exploreFileView', () => {
  it('routes by what Explore can actually open', () => {
    expect(exploreFileView('analyses/explore/revenue.sql')).toBe('sql')
    expect(exploreFileView('charts/sales.yml')).toBe('dashboards')
    expect(exploreFileView('charts/sales.YAML')).toBe('dashboards')
    // A model or a doc has no editor on this page: the panel must not offer it.
    expect(exploreFileView('models/marts/orders.sql')).toBe('sql')
    expect(exploreFileView('README.md')).toBeNull()
  })
})
