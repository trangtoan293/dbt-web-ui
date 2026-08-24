import { describe, it, expect } from 'vitest'
import { isBlockCode } from '@/components-v2/develop/agent/markdown-code'

describe('isBlockCode', () => {
  it('treats a fenced block as a block', () => {
    expect(isBlockCode('language-sql', 'select 1')).toBe(true)
  })

  it('treats a fence with no language as a block', () => {
    expect(isBlockCode(undefined, 'select 1\nfrom t')).toBe(true)
  })

  it('leaves an inline span inline', () => {
    expect(isBlockCode(undefined, 'dbt run')).toBe(false)
  })
})
